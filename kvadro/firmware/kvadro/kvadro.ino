// КВАДРО — пульт для квадроцикла с вариатором (черновик под Linhai-Yamaha M550L).
// Плата: ESP32 DevKit. Связь: Bluetooth LE, пульт — страница в Chrome на Android (Web Bluetooth).
//
// Что умеет: завести / заглушить, проехать прямо N метров на пониженной (L) и остановиться.
// Руль и рычаг передач НЕ трогает: передачу L ставишь сам, едет только прямо.
//
// Безопасность — главное в этом файле:
//  * Мотор работает, только пока реле «разрешение мотора» под током. Обесточилась плата, сгорел провод,
//    плата зависла — реле отпало, мотор глохнет. Подключать так, чтобы ОТПУЩЕННОЕ реле глушило мотор.
//  * Телефон шлёт «я на связи» 10 раз в секунду. Тишина дольше LINK_TIMEOUT_MS — газ в ноль, тормоз, мотор глушим.
//  * Ехать можно, только пока на телефоне ЗАЖАТА кнопка (мёртвая рука). Отпустил — газ в ноль и тормоз.
//  * Газ ограничен сверху (THR_MAX_US) — и ещё механическим упором на тросике, его ставишь руками.
//  * Газ открыт, а колесо не крутится 3 с — стоп (упёрся или датчик отвалился).
//  * Скорость выше SPEED_PANIC — авария. Заезд дольше RUN_MAX_S — стоп.
//  * Отдельный брелок 433 МГц рвёт цепь глушения в обход всей этой электроники (см. README).
//  * Командовать может только тот, кто ввёл PIN.
//
// ЧЕРНОВИК: на живом квадроцикле не проверен. Числа в настройках — прикидки, подбираем на месте,
// сначала на подставках с вывешенными колёсами.
// Имена в коде латиницей: старый компилятор ESP32 (ядро 2.x) не понимает русские идентификаторы.

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_timer.h"

// ===================== НАСТРОЙКИ =====================
const char* BLE_NAME = "KVADRO";
const char* PIN_CODE = "4815";            // поменяй! Тот же вводишь в пульте

// Ножки ESP32 (без «капризных» при загрузке: 0, 2, 12, 15)
const int P_STARTER  = 26;   // реле параллельно кнопке стартера
const int P_ENGINE   = 27;   // реле «разрешение мотора»: под током — мотор может работать
const int P_THROTTLE = 25;   // сигнал сервы газа
const int P_BRAKE_ON  = 32;  // мост BTS7960, RPWM: актуатор выдвигается — жмёт тормоз
const int P_BRAKE_OFF = 33;  // мост BTS7960, LPWM: актуатор втягивается — отпускает
const int P_WHEEL    = 34;   // датчик Холла (только вход; подтяжка 10 кОм к 3.3 В снаружи)
const int P_VOLT     = 35;   // АКБ через делитель 100 кОм / 22 кОм

const bool RELAY_ON_HIGH = true;   // у многих китайских модулей реле включается LOW — тогда false

// Газ (серва), длительность импульса в мкс. Подбираем на месте: ZERO — газ закрыт, MAX — чуть приоткрыт
const int   THR_ZERO_US = 1000;
const int   THR_RUN_US  = 1200;    // обычный газ в заезде
const int   THR_MAX_US  = 1300;    // выше прошивка не даст никогда
const float THR_RAMP_S  = 1.5;     // от нуля до THR_RUN плавно за столько секунд

// Тормоз: актуатор с концевиками — жмём/отпускаем по времени, в краю концевик сам остановит
const int BRAKE_TRAVEL_MS = 1500;

// Колесо: шина 25" ≈ 0.635 м, окружность ≈ 1.99 м. Магнитов на колесе (или валу) — сколько поставишь
const float WHEEL_CIRC_M = 1.99;
const int   MAGNETS = 4;

// Пределы
const uint32_t LINK_TIMEOUT_MS = 350;
const float SPEED_MAX   = 5.0;      // км/ч — выше закрываем газ
const float SPEED_PANIC = 9.0;      // км/ч — выше авария, глушим
const float DIST_MAX_M  = 50.0;     // больше за раз не дадим
const uint32_t RUN_MAX_S = 60;
const uint32_t WHEEL_STUCK_MS = 3000;   // газ открыт, а импульсов нет столько — стоп
const float BRAKE_EARLY_M = 0.6;        // тормозить чуть раньше цели — докатится

// Запуск
const uint32_t IGN_BEFORE_CRANK_MS = 300;   // зажигание включили — подождали — стартер
const uint32_t CRANK_MAX_MS = 2500;
const uint32_t CRANK_REST_MS = 5000;
const float VOLT_RUNNING = 13.3;            // В: генератор заряжает — значит, завёлся
const float VOLT_DIV = (100.0 + 22.0) / 22.0;

// ===================== СОСТОЯНИЕ =====================
enum Mode { READY, STARTING, IDLE, DRIVING, PANIC };
const char* MODE_NAME[] = { "ГОТОВ", "ЗАПУСК", "МОТОР", "ЕДЕТ", "АВАРИЯ" };

volatile Mode mode = READY;
volatile uint32_t pulses = 0;
volatile uint32_t lastPulseUs = 0;
volatile uint32_t lastLoopMs = 0;        // для сторожа: loop жив?

volatile bool connected = false, authed = false;
volatile uint32_t lastLinkMs = 0;
volatile bool holding = false;           // мёртвая рука: кнопка «ЕХАТЬ» на телефоне зажата
String reason = "";

float targetM = 0;
uint32_t pulsesAtStart = 0, runStartMs = 0, lastMoveMs = 0, pulsesSeen = 0;
uint32_t ignOnMs = 0, crankStartMs = 0, crankRestUntil = 0;
bool cranking = false;
int thrUs = THR_ZERO_US;
bool brakeOn = false;
uint32_t brakeUntil = 0;
float speedKmh = 0;

// Команды из Bluetooth приходят в другой задаче — складываем и разбираем в loop, чтобы не гоняться
portMUX_TYPE cmdMux = portMUX_INITIALIZER_UNLOCKED;
String pendingCmd = "";
volatile bool linkLost = false;

BLECharacteristic* chStatus = nullptr;
#define UUID_SERVICE "7f1a0001-6b5e-4c1a-9d7e-4b5241445230"
#define UUID_CMD     "7f1a0002-6b5e-4c1a-9d7e-4b5241445230"
#define UUID_STATUS  "7f1a0003-6b5e-4c1a-9d7e-4b5241445230"

// ===================== ЖЕЛЕЗО =====================
void relay(int pin, bool on) { digitalWrite(pin, (on == RELAY_ON_HIGH) ? HIGH : LOW); }

// серва: 50 Гц, 14 бит — период 20000 мкс
const int SERVO_BITS = 14;
void throttleUs(int us) {
  us = constrain(us, THR_ZERO_US, THR_MAX_US);
  thrUs = us;
  uint32_t duty = (uint32_t)((float)us / 20000.0f * ((1 << SERVO_BITS) - 1));
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(P_THROTTLE, duty);
#else
  ledcWrite(0, duty);
#endif
}
void throttleZero() { throttleUs(THR_ZERO_US); }

void brake(bool on) {
  digitalWrite(P_BRAKE_ON, on ? HIGH : LOW);
  digitalWrite(P_BRAKE_OFF, on ? LOW : HIGH);
  brakeOn = on;
  brakeUntil = millis() + BRAKE_TRAVEL_MS;
}

float volts() { return analogReadMilliVolts(P_VOLT) / 1000.0f * VOLT_DIV; }
bool engineRunning() { return volts() > VOLT_RUNNING; }

void IRAM_ATTR onWheel() {
  uint32_t t = micros();
  if (t - lastPulseUs > 5000) { pulses++; lastPulseUs = t; }   // дребезг
}

void panic(const String& why) {          // авария: газ ноль, стартер отпущен, мотор глушим, тормоз
  throttleZero();
  relay(P_STARTER, false); cranking = false;
  relay(P_ENGINE, false);
  brake(true);
  mode = PANIC; reason = why;
}

void stopRun(const String& why) {        // штатная остановка: газ ноль, тормоз, мотор работает
  throttleZero(); brake(true);
  mode = engineRunning() ? IDLE : READY; reason = why;
}

void killEngine(const String& why) {
  throttleZero(); relay(P_STARTER, false); cranking = false; relay(P_ENGINE, false); brake(true);
  if (mode != PANIC) mode = READY;
  reason = why;
}

// Сторож в задаче таймера: loop не крутится полсекунды (завис) — рвём мотор и стартер напрямую
void watchdog(void*) {
  if (millis() - lastLoopMs > 500) {
    digitalWrite(P_ENGINE, RELAY_ON_HIGH ? LOW : HIGH);
    digitalWrite(P_STARTER, RELAY_ON_HIGH ? LOW : HIGH);
  }
}

// ===================== КОМАНДЫ =====================
// Текстом, по одной в пакете:
//   PIN 4815     — представиться (без этого остальное не слушаем)
//   HB 0 / HB 1  — «я на связи»; 1 — кнопка «ЕХАТЬ» зажата
//   START        — завести
//   KILL         — заглушить
//   GO 12.5      — проехать 12.5 м (только пока HB 1)
//   STOP         — стоп: газ ноль и тормоз
//   RESET        — снять аварию (мотор остаётся заглушен)
//   SERVO 1150   — калибровка газа (только при заглушенном моторе)
//   BRAKE 1/0    — проверка тормоза (только при заглушенном моторе)
void handleCommand(String c) {
  c.trim();
  if (c.startsWith("PIN ")) { authed = (c.substring(4) == PIN_CODE); reason = authed ? "PIN принят" : "Неверный PIN"; lastLinkMs = millis(); return; }
  if (!authed) return;
  if (c.startsWith("HB ")) return;      // связь и «держит» уже учтены в приёмнике
  if (c == "STOP") { if (mode == DRIVING) stopRun("Стоп с пульта"); else { throttleZero(); brake(true); } return; }
  if (c == "KILL") { killEngine("Заглушен"); return; }
  if (c == "RESET") { if (mode == PANIC) { mode = READY; reason = "Авария снята"; } return; }
  if (c == "START") {
    if (mode != READY) { reason = "Запуск только из ГОТОВ"; return; }
    if (millis() < crankRestUntil) { reason = "Подожди — стартер остывает"; return; }
    brake(true);                        // заодно замыкает концевик тормоза: без него многие квадры не крутят стартер
    relay(P_ENGINE, true); ignOnMs = millis(); cranking = false;
    mode = STARTING; reason = "Зажигание";
    return;
  }
  if (c.startsWith("GO ")) {
    float m = c.substring(3).toFloat();
    if (mode != IDLE) { reason = "Сначала заведи"; return; }
    if (!holding) { reason = "Зажми кнопку ЕХАТЬ"; return; }
    if (!(m >= 0.5f && m <= DIST_MAX_M)) { reason = "Дистанция 0.5–" + String(DIST_MAX_M, 0) + " м"; return; }
    targetM = m; pulsesAtStart = pulsesSeen = pulses; runStartMs = lastMoveMs = millis();
    brake(false);
    mode = DRIVING; reason = "Еду " + String(m, 1) + " м";
    return;
  }
  if (c.startsWith("SERVO ")) { if (mode == READY || mode == PANIC) { throttleUs(c.substring(6).toInt()); reason = "Серва " + String(thrUs); } return; }
  if (c.startsWith("BRAKE ")) { if (mode == READY || mode == PANIC) { brake(c.endsWith("1")); reason = brakeOn ? "Тормоз жму" : "Тормоз отпускаю"; } return; }
}

class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* ch) override {
    String c = String(ch->getValue().c_str()); c.trim();
    // «я на связи» отмечаем сразу (быстро и без строк в loop), остальное — в очередь
    if (authed && c.startsWith("HB ")) { lastLinkMs = millis(); holding = c.endsWith("1"); return; }
    if (authed) lastLinkMs = millis();
    portENTER_CRITICAL(&cmdMux);
    bool free = pendingCmd.length() == 0;
    portEXIT_CRITICAL(&cmdMux);
    if (free || c == "STOP" || c == "KILL") { portENTER_CRITICAL(&cmdMux); pendingCmd = c; portEXIT_CRITICAL(&cmdMux); }   // СТОП важнее всего
  }
};
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { connected = true; authed = false; holding = false; lastLinkMs = millis(); }
  void onDisconnect(BLEServer* s) override {
    connected = false; authed = false; holding = false; linkLost = true;
    s->getAdvertising()->start();
  }
};

// ===================== ЗАПУСК ПЛАТЫ =====================
void setup() {
  // сначала всё в безопасное — до любой другой работы
  pinMode(P_STARTER, OUTPUT); relay(P_STARTER, false);
  pinMode(P_ENGINE, OUTPUT);  relay(P_ENGINE, false);
  pinMode(P_BRAKE_ON, OUTPUT); pinMode(P_BRAKE_OFF, OUTPUT);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(P_THROTTLE, 50, SERVO_BITS);
#else
  ledcSetup(0, 50, SERVO_BITS); ledcAttachPin(P_THROTTLE, 0);
#endif
  throttleZero(); brake(true);
  pinMode(P_WHEEL, INPUT);
  attachInterrupt(digitalPinToInterrupt(P_WHEEL), onWheel, FALLING);
  Serial.begin(115200);

  lastLoopMs = millis();
  esp_timer_create_args_t ta = {};
  ta.callback = &watchdog; ta.arg = nullptr; ta.dispatch_method = ESP_TIMER_TASK; ta.name = "watchdog";
  esp_timer_handle_t th; esp_timer_create(&ta, &th); esp_timer_start_periodic(th, 100000);   // каждые 100 мс

  BLEDevice::init(BLE_NAME);
  BLEServer* srv = BLEDevice::createServer(); srv->setCallbacks(new ServerCallbacks());
  BLEService* svc = srv->createService(UUID_SERVICE);
  BLECharacteristic* chCmd = svc->createCharacteristic(UUID_CMD, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  chCmd->setCallbacks(new CmdCallbacks());
  chStatus = svc->createCharacteristic(UUID_STATUS, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chStatus->addDescriptor(new BLE2902());
  svc->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising(); adv->addServiceUUID(UUID_SERVICE); adv->start();
  Serial.println("KVADRO ready");
}

// ===================== ГЛАВНЫЙ ЦИКЛ =====================
uint32_t reportMs = 0, speedMs = 0, pulsesForSpeed = 0;

void loop() {
  uint32_t now = millis();
  lastLoopMs = now;

  // команда из Bluetooth
  String c = "";
  portENTER_CRITICAL(&cmdMux); if (pendingCmd.length()) { c = pendingCmd; pendingCmd = ""; } portEXIT_CRITICAL(&cmdMux);
  if (c.length()) handleCommand(c);

  // мост тормоза: подали ход — через BRAKE_TRAVEL_MS снимаем ток (концевики уже остановили)
  if (brakeUntil && now > brakeUntil) { digitalWrite(P_BRAKE_ON, LOW); digitalWrite(P_BRAKE_OFF, LOW); brakeUntil = 0; }

  // скорость — раз в полсекунды по импульсам колеса
  if (now - speedMs >= 500) {
    uint32_t p = pulses;
    float m = (float)(p - pulsesForSpeed) / MAGNETS * WHEEL_CIRC_M;
    speedKmh = m / ((now - speedMs) / 1000.0f) * 3.6f;
    pulsesForSpeed = p; speedMs = now;
  }

  // связь: оборвалась или молчит — авария (если мотор под током)
  bool engineOn = (mode == STARTING || mode == IDLE || mode == DRIVING);
  if (engineOn && (linkLost || !authed || now - lastLinkMs > LINK_TIMEOUT_MS)) panic(linkLost ? "Связь оборвалась" : "Пропала связь");
  linkLost = false;

  if (mode == STARTING) {
    if (!cranking && now - ignOnMs > IGN_BEFORE_CRANK_MS) { relay(P_STARTER, true); cranking = true; crankStartMs = now; reason = "Кручу стартер"; }
    if (cranking && now - crankStartMs > 300 && engineRunning()) { relay(P_STARTER, false); cranking = false; mode = IDLE; reason = "Завёлся"; }
    else if (cranking && now - crankStartMs > CRANK_MAX_MS) {
      relay(P_STARTER, false); cranking = false; relay(P_ENGINE, false);
      crankRestUntil = now + CRANK_REST_MS; mode = READY; reason = "Не завёлся";
    }
  }

  if (mode == IDLE && !engineRunning()) { relay(P_ENGINE, false); mode = READY; reason = "Мотор заглох"; }

  if (mode == DRIVING) {
    uint32_t p = pulses;
    if (p != pulsesSeen) { pulsesSeen = p; lastMoveMs = now; }
    float done = (float)(p - pulsesAtStart) / MAGNETS * WHEEL_CIRC_M;
    if (!holding) stopRun("Отпустил кнопку");
    else if (speedKmh > SPEED_PANIC) panic("Слишком быстро: " + String(speedKmh, 1) + " км/ч");
    else if (done >= targetM - BRAKE_EARLY_M) stopRun("Приехал: " + String(done, 1) + " м");
    else if (now - runStartMs > RUN_MAX_S * 1000UL) stopRun("Слишком долго");
    else if (thrUs > THR_ZERO_US + 50 && now - lastMoveMs > WHEEL_STUCK_MS) stopRun("Колесо не крутится");
    else {
      // газ: плавный разгон; за 2 м до цели — вполовину; быстрее SPEED_MAX — закрыть
      float k = min(1.0f, (now - runStartMs) / (THR_RAMP_S * 1000.0f));
      int t = THR_ZERO_US + (int)((THR_RUN_US - THR_ZERO_US) * k);
      if (targetM - done < 2.0f) t = THR_ZERO_US + (t - THR_ZERO_US) / 2;
      if (speedKmh > SPEED_MAX) t = THR_ZERO_US;
      throttleUs(t);
    }
  }

  // отчёт на телефон 5 раз в секунду: режим;пройдено;цель;скорость;напряжение;газ;тормоз;причина;свой
  if (connected && now - reportMs >= 200) {
    reportMs = now;
    float done = mode == DRIVING ? (float)(pulses - pulsesAtStart) / MAGNETS * WHEEL_CIRC_M : 0;
    String s = String(MODE_NAME[mode]) + ";" + String(done, 1) + ";" + String(targetM, 1) + ";" + String(speedKmh, 1) + ";" +
               String(volts(), 1) + ";" + String(thrUs) + ";" + (brakeOn ? "1" : "0") + ";" + reason + ";" + (authed ? "1" : "0");
    chStatus->setValue(s.c_str());
    chStatus->notify();
  }
  delay(10);
}
