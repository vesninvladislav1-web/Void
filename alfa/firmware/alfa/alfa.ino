// АЛЬФА — коробочка на мотоцикл Альфа 125: прогрев с телефона, моточасы и обслуживание, журнал поездок.
// Плата ESP32. Связь — домашний Wi-Fi: страничка открывается в браузере на http://alfa.local (или по IP).
// Пароль от Wi-Fi и PIN — в secrets.h (его нет в репозитории; скопируй secrets.h.example → secrets.h).
//
// Прогрев:
//  * заводит ТОЛЬКО на нейтрали (провод лампочки N), стоя ровно (не упал), и — если включено — при открытых воротах;
//  * реле зажигания стоит ПАРАЛЛЕЛЬНО ключу: плата может только «добавить» зажигание. Если ключ включён — мотор
//    работает от ключа, и плата его не заглушит никогда. Глушить может только свой же прогрев (ключ выключен);
//  * глушит сам: по таймеру, если упал, если кто-то включил передачу или поехал без ключа;
//  * стартер — не дольше 3 с за раз, две попытки, между ними пауза.
// Моточасы — пока мотор работает (генератор держит больше 13.2 В). Км — по GPS.
// Журнал — каждая поездка в файл на карте памяти; в гараже по Wi-Fi видно на карте.
//
// ЧЕРНОВИК: на живой Альфе не проверен. Числа подбираем на месте. Имена в коде латиницей —
// старый компилятор ESP32 (ядро 2.x) не понимает русские идентификаторы.

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <SPI.h>
#include <SD.h>
#include <Wire.h>
#include <TinyGPSPlus.h>     // ставится из «Управления библиотеками»: TinyGPSPlus (Mikal Hart)
#include "secrets.h"         // WIFI_SSID, WIFI_PASS, CONTROL_PIN
#include "page.h"            // страничка (PAGE_HTML)

// ===================== НОЖКИ =====================
const int P_IGN     = 26;   // реле зажигания — параллельно ключу
const int P_STARTER = 27;   // реле стартера — параллельно кнопке старта
const int P_NEUTRAL = 14;   // лампочка N через оптопару: LOW = нейтраль
const int P_GATE    = 13;   // геркон ворот (к массе): замкнут (LOW) = ворота закрыты
const int P_CHOKE   = 25;   // серва подсоса (если есть)
const int P_VOLT    = 35;   // АКБ через делитель 100 кОм / 22 кОм
const int P_GPS_RX  = 16, P_GPS_TX = 17;   // GPS на Serial2
const int P_SD_CS   = 5;    // SD: SCK 18, MISO 19, MOSI 23
// MPU6050: SDA 21, SCL 22

const bool RELAY_ON_HIGH = true;   // у многих китайских модулей реле включается LOW — тогда false

// ===================== НАСТРОЙКИ =====================
const float VOLT_DIV = (100.0 + 22.0) / 22.0;
const float VOLT_RUNNING = 13.2;          // больше — мотор работает (генератор заряжает)
const uint32_t CRANK_MAX_MS = 3000;
const uint32_t CRANK_REST_MS = 6000;
const int CRANK_TRIES = 2;
const uint32_t CHOKE_HOLD_MS = 60000;     // подсос держим первую минуту
const int CHOKE_ON_US = 1900, CHOKE_OFF_US = 1100;
const float FALL_DEG = 40.0;              // наклон больше — упал (на подножке Альфа стоит градусов на 10–15)
const float THEFT_KMH = 4.0;              // во время прогрева поехал быстрее — глушим (ключ выключен = не хозяин)
const uint32_t TRIP_END_MS = 90000;       // мотор не работает столько — поездка закончилась
const uint32_t LOG_EVERY_MS = 2000;

// Обслуживание: что, раз в сколько км и/или моточасов (что раньше). Интервалы поправь по своей книжке.
struct Service { const char* name; float km; float hours; };
Service SERVICES[] = {
  { "Масло в двигателе",       1500, 30 },
  { "Смазать цепь",             400,  0 },
  { "Натяжка цепи",            1000,  0 },
  { "Свеча",                   4000,  0 },
  { "Воздушный фильтр",        3000,  0 },
  { "Зазоры клапанов",         3000, 60 },
};
const int N_SERVICES = sizeof(SERVICES) / sizeof(SERVICES[0]);

// ===================== СОСТОЯНИЕ =====================
enum WarmMode { W_OFF, W_STARTING, W_RUNNING };
WarmMode warm = W_OFF;
String reason = "";
uint32_t warmUntilMs = 0, warmStartMs = 0, crankStartMs = 0, nextCrankMs = 0, crankRestUntil = 0;
int crankTry = 0;
bool cranking = false, chokeOn = false;

// настройки, которые меняются со странички (хранятся в памяти платы)
int warmMinutes = 3;          // по умолчанию 3, можно до 5
bool checkGate = false;       // проверять ворота
bool useChoke = false;        // есть серва подсоса

// счётчики
double totalKm = 0; uint32_t engineSec = 0;
double svcKm[16]; uint32_t svcSec[16];   // на каком пробеге/моточасах делали последний раз
Preferences prefs;
uint32_t lastSaveMs = 0, runAccMs = 0, lastLoopMs = 0;

// GPS и поездки
TinyGPSPlus gps;
bool sdOk = false;
bool tripOn = false; File tripFile; int tripId = 0;
double tripKm = 0, tripMax = 0, lastLat = 0, lastLon = 0; bool havePrev = false;
uint32_t tripStartMs = 0, lastRunMs = 0, lastLogMs = 0;
String tripStartTime = "";

// наклон
float tiltDeg = 0; bool mpuOk = false;

WebServer server(80);

// ===================== ЖЕЛЕЗО =====================
void relay(int pin, bool on) { digitalWrite(pin, (on == RELAY_ON_HIGH) ? HIGH : LOW); }
float volts() { return analogReadMilliVolts(P_VOLT) / 1000.0f * VOLT_DIV; }
bool engineRunning() { return volts() > VOLT_RUNNING; }
bool inNeutral() { return digitalRead(P_NEUTRAL) == LOW; }
bool gateClosed() { return digitalRead(P_GATE) == LOW; }
float gpsKmh() { return gps.speed.isValid() && gps.speed.age() < 3000 ? gps.speed.kmph() : 0; }

const int SERVO_BITS = 14;
void chokeUs(int us) {
  uint32_t duty = (uint32_t)((float)us / 20000.0f * ((1 << SERVO_BITS) - 1));
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(P_CHOKE, duty);
#else
  ledcWrite(0, duty);
#endif
}
void choke(bool on) { if (!useChoke) return; chokeUs(on ? CHOKE_ON_US : CHOKE_OFF_US); chokeOn = on; }

// MPU6050 без библиотек: регистр 0x6B — разбудить, 0x3B — ускорения
void mpuInit() {
  Wire.begin(21, 22);
  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0);
  mpuOk = Wire.endTransmission() == 0;
}
void mpuRead() {
  if (!mpuOk) return;
  Wire.beginTransmission(0x68); Wire.write(0x3B); if (Wire.endTransmission(false) != 0) return;
  if (Wire.requestFrom(0x68, 6) != 6) return;
  int16_t ax = (Wire.read() << 8) | Wire.read(), ay = (Wire.read() << 8) | Wire.read(), az = (Wire.read() << 8) | Wire.read();
  // угол от вертикали: коробку ставим так, чтобы ось Z смотрела вверх
  float g = sqrtf((float)ax * ax + (float)ay * ay + (float)az * az);
  if (g > 1000) tiltDeg = acosf(constrain((float)az / g, -1.0f, 1.0f)) * 57.2958f;
}

// ===================== ПРОГРЕВ =====================
void warmStop(const String& why) {
  relay(P_STARTER, false); cranking = false;
  relay(P_IGN, false);      // если ключ включён — мотор от ключа и работает дальше
  choke(false);
  warm = W_OFF; reason = why;
}

String warmCheck() {   // пустая строка — можно заводить
  if (warm != W_OFF) return "Уже прогреваю";
  if (engineRunning()) return "Мотор уже работает";
  if (!inNeutral()) return "Не нейтраль — поставь N";
  if (mpuOk && tiltDeg > FALL_DEG) return "Лежит на боку";
  if (checkGate && gateClosed()) return "Открой ворота гаража";
  if (millis() < crankRestUntil) return "Стартер остывает";
  return "";
}

void warmStart(int minutes) {
  String no = warmCheck(); if (no.length()) { reason = no; return; }
  warmMinutes = constrain(minutes, 1, 5);
  choke(true);
  relay(P_IGN, true); nextCrankMs = millis() + 1000; cranking = false; crankTry = 0;   // секунду на включение зажигания
  warm = W_STARTING; reason = "Зажигание";
}

void warmLoop(uint32_t now) {
  if (warm == W_OFF) return;
  // общие стоп-условия: упал, включили передачу, поехал без ключа
  if (mpuOk && tiltDeg > FALL_DEG) { warmStop("Упал — заглушил"); return; }
  if (!inNeutral()) { warmStop("Включили передачу — заглушил"); return; }
  if (gpsKmh() > THEFT_KMH) { warmStop("Поехал без ключа — заглушил"); return; }

  if (warm == W_STARTING) {
    if (!cranking && (int32_t)(now - nextCrankMs) >= 0) { relay(P_STARTER, true); cranking = true; crankStartMs = now; crankTry++; reason = "Кручу стартер (" + String(crankTry) + ")"; }
    if (cranking && now - crankStartMs > 400 && engineRunning()) {
      relay(P_STARTER, false); cranking = false;
      warm = W_RUNNING; warmStartMs = now; warmUntilMs = now + warmMinutes * 60000UL; reason = "Завёлся, грею";
    } else if (cranking && now - crankStartMs > CRANK_MAX_MS) {
      relay(P_STARTER, false); cranking = false;
      if (crankTry >= CRANK_TRIES) { crankRestUntil = now + CRANK_REST_MS; warmStop("Не завёлся"); }
      else { nextCrankMs = now + CRANK_REST_MS; reason = "Пауза перед второй попыткой"; }
    }
    return;
  }
  // W_RUNNING
  if (useChoke && chokeOn && now - warmStartMs > CHOKE_HOLD_MS) choke(false);
  if (!engineRunning()) { warmStop("Заглох"); return; }
  if ((int32_t)(now - warmUntilMs) >= 0) warmStop("Прогрет");
}

// ===================== СЧЁТЧИКИ =====================
void loadPrefs() {
  prefs.begin("alfa", false);
  totalKm = prefs.getDouble("km", 0); engineSec = prefs.getULong("sec", 0);
  warmMinutes = prefs.getInt("warm", 3); checkGate = prefs.getBool("gate", false); useChoke = prefs.getBool("choke", false);
  tripId = prefs.getInt("trip", 0);
  for (int i = 0; i < N_SERVICES; i++) { svcKm[i] = prefs.getDouble(("k" + String(i)).c_str(), 0); svcSec[i] = prefs.getULong(("h" + String(i)).c_str(), 0); }
}
void saveCounters() { prefs.putDouble("km", totalKm); prefs.putULong("sec", engineSec); }

// ===================== ПОЕЗДКИ =====================
String gpsTime() {
  if (!gps.date.isValid() || !gps.time.isValid()) return "";
  char b[24]; snprintf(b, sizeof b, "%04d-%02d-%02d %02d:%02d", gps.date.year(), gps.date.month(), gps.date.day(), gps.time.hour(), gps.time.minute());
  return String(b) + " UTC";
}
void tripBegin(uint32_t now) {
  tripOn = true; tripKm = 0; tripMax = 0; havePrev = false; tripStartMs = now; tripStartTime = gpsTime();
  tripId++; prefs.putInt("trip", tripId);
  if (sdOk) { tripFile = SD.open("/trips/" + String(tripId) + ".csv", FILE_WRITE); if (tripFile) tripFile.println("t,lat,lon,kmh,alt"); }
}
void tripEnd() {
  if (!tripOn) return;
  tripOn = false;
  if (tripFile) tripFile.close();
  if (sdOk && tripKm > 0.05) {   // пустые «поездки» (прогрев в гараже) в журнал не пишем
    File idx = SD.open("/trips/index.csv", FILE_APPEND);
    if (idx) { idx.printf("%d,%s,%.2f,%.0f,%lu\n", tripId, tripStartTime.c_str(), tripKm, tripMax, (unsigned long)((millis() - tripStartMs) / 1000)); idx.close(); }
  } else if (sdOk) SD.remove("/trips/" + String(tripId) + ".csv");
}
void tripLoop(uint32_t now, bool running) {
  if (running) lastRunMs = now;
  if (!tripOn && running && warm == W_OFF) tripBegin(now);         // прогрев — не поездка
  if (tripOn && !running && now - lastRunMs > TRIP_END_MS) tripEnd();
  if (!tripOn || !gps.location.isValid() || gps.location.age() > 3000) return;
  double lat = gps.location.lat(), lon = gps.location.lng(); float kmh = gpsKmh();
  if (kmh > 3 && havePrev) { double d = TinyGPSPlus::distanceBetween(lastLat, lastLon, lat, lon) / 1000.0; if (d < 0.2) { tripKm += d; totalKm += d; } }
  if (kmh > 3 || !havePrev) { lastLat = lat; lastLon = lon; havePrev = true; }
  if (kmh > tripMax) tripMax = kmh;
  if (tripFile && now - lastLogMs >= LOG_EVERY_MS) {
    lastLogMs = now;
    tripFile.printf("%lu,%.6f,%.6f,%.1f,%.0f\n", (unsigned long)((now - tripStartMs) / 1000), lat, lon, kmh, gps.altitude.meters());
    tripFile.flush();
  }
}

// ===================== ВЕБ =====================
bool pinOk() { return server.arg("pin") == CONTROL_PIN; }
String esc(const String& s) { String o; for (unsigned i = 0; i < s.length(); i++) { char c = s[i]; if (c == '"' || c == '\\') o += '\\'; o += c; } return o; }

void apiState() {
  String j = "{";
  j += "\"warm\":\"" + String(warm == W_OFF ? "off" : warm == W_STARTING ? "starting" : "running") + "\",";
  j += "\"left\":" + String(warm == W_RUNNING ? max(0L, (long)(int32_t)(warmUntilMs - millis()) / 1000) : 0L) + ",";
  j += "\"reason\":\"" + esc(reason) + "\",";
  j += "\"engine\":" + String(engineRunning() ? "true" : "false") + ",";
  j += "\"volt\":" + String(volts(), 1) + ",";
  j += "\"neutral\":" + String(inNeutral() ? "true" : "false") + ",";
  j += "\"gate\":\"" + String(checkGate ? (gateClosed() ? "closed" : "open") : "off") + "\",";
  j += "\"tilt\":" + String(mpuOk ? tiltDeg : -1, 0) + ",";
  j += "\"gps\":" + String(gps.location.isValid() && gps.location.age() < 3000 ? "true" : "false") + ",";
  j += "\"sats\":" + String(gps.satellites.isValid() ? gps.satellites.value() : 0) + ",";
  j += "\"km\":" + String(totalKm, 1) + ",\"hours\":" + String(engineSec / 3600.0, 1) + ",";
  j += "\"trip\":" + String(tripOn ? "true" : "false") + ",\"tripKm\":" + String(tripKm, 2) + ",";
  j += "\"sd\":" + String(sdOk ? "true" : "false") + ",";
  j += "\"settings\":{\"warm\":" + String(warmMinutes) + ",\"gate\":" + (checkGate ? "true" : "false") + ",\"choke\":" + (useChoke ? "true" : "false") + "},";
  j += "\"service\":[";
  for (int i = 0; i < N_SERVICES; i++) {
    if (i) j += ",";
    j += "{\"name\":\"" + String(SERVICES[i].name) + "\",\"km\":" + String(SERVICES[i].km, 0) + ",\"hours\":" + String(SERVICES[i].hours, 0) +
         ",\"doneKm\":" + String(svcKm[i], 1) + ",\"doneHours\":" + String(svcSec[i] / 3600.0, 1) + "}";
  }
  j += "]}";
  server.send(200, "application/json", j);
}

void setupWeb() {
  server.on("/", HTTP_GET, [] { server.send_P(200, "text/html; charset=utf-8", PAGE_HTML); });
  server.on("/api/state", HTTP_GET, apiState);
  server.on("/api/warm", HTTP_POST, [] {
    if (!pinOk()) { server.send(403, "text/plain", "PIN"); return; }
    warmStart(server.arg("min").toInt()); server.send(200, "text/plain", reason);
  });
  server.on("/api/stop", HTTP_POST, [] {   // «стоп» — без PIN: остановить может любой
    if (warm != W_OFF) warmStop("Остановлен с телефона");
    server.send(200, "text/plain", reason);
  });
  server.on("/api/settings", HTTP_POST, [] {
    if (!pinOk()) { server.send(403, "text/plain", "PIN"); return; }
    if (server.hasArg("warm")) { warmMinutes = constrain(server.arg("warm").toInt(), 1, 5); prefs.putInt("warm", warmMinutes); }
    if (server.hasArg("gate")) { checkGate = server.arg("gate") == "1"; prefs.putBool("gate", checkGate); }
    if (server.hasArg("choke")) { useChoke = server.arg("choke") == "1"; prefs.putBool("choke", useChoke); }
    server.send(200, "text/plain", "ok");
  });
  server.on("/api/service", HTTP_POST, [] {   // «сделал» — отметить обслуживание на текущем пробеге
    if (!pinOk()) { server.send(403, "text/plain", "PIN"); return; }
    int i = server.arg("i").toInt(); if (i < 0 || i >= N_SERVICES) { server.send(400, "text/plain", "?"); return; }
    svcKm[i] = totalKm; svcSec[i] = engineSec;
    prefs.putDouble(("k" + String(i)).c_str(), svcKm[i]); prefs.putULong(("h" + String(i)).c_str(), svcSec[i]);
    server.send(200, "text/plain", "ok");
  });
  server.on("/api/trips", HTTP_GET, [] {   // список поездок: id,время,км,макс,секунды
    if (!sdOk) { server.send(200, "text/plain", ""); return; }
    File f = SD.open("/trips/index.csv"); if (!f) { server.send(200, "text/plain", ""); return; }
    server.streamFile(f, "text/plain"); f.close();
  });
  server.on("/api/trip", HTTP_GET, [] {    // одна поездка — CSV точек
    int id = server.arg("id").toInt();
    if (!sdOk || id <= 0) { server.send(404, "text/plain", ""); return; }
    File f = SD.open("/trips/" + String(id) + ".csv"); if (!f) { server.send(404, "text/plain", ""); return; }
    server.streamFile(f, "text/csv"); f.close();
  });
  server.begin();
}

// ===================== ЗАПУСК =====================
void setup() {
  // сначала всё в безопасное
  pinMode(P_IGN, OUTPUT); relay(P_IGN, false);
  pinMode(P_STARTER, OUTPUT); relay(P_STARTER, false);
  pinMode(P_NEUTRAL, INPUT_PULLUP); pinMode(P_GATE, INPUT_PULLUP);
  Serial.begin(115200);
  loadPrefs();
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(P_CHOKE, 50, SERVO_BITS);
#else
  ledcSetup(0, 50, SERVO_BITS); ledcAttachPin(P_CHOKE, 0);
#endif
  if (useChoke) chokeUs(CHOKE_OFF_US);
  Serial2.begin(9600, SERIAL_8N1, P_GPS_RX, P_GPS_TX);
  mpuInit();
  sdOk = SD.begin(P_SD_CS); if (sdOk && !SD.exists("/trips")) SD.mkdir("/trips");

  WiFi.mode(WIFI_STA); WiFi.setHostname("alfa"); WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  MDNS.begin("alfa");
  setupWeb();
  Serial.println("ALFA ready");
}

void loop() {
  uint32_t now = millis();
  uint32_t dt = now - lastLoopMs; lastLoopMs = now;
  while (Serial2.available()) gps.encode(Serial2.read());
  mpuRead();

  bool running = engineRunning();
  if (running) { runAccMs += dt; while (runAccMs >= 1000) { runAccMs -= 1000; engineSec++; } }

  warmLoop(now);
  tripLoop(now, running);
  if (now - lastSaveMs > 60000) { lastSaveMs = now; saveCounters(); }   // раз в минуту — память не износится

  server.handleClient();
  delay(5);
}
