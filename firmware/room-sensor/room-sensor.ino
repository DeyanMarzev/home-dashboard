// Room sensor for the home dashboard: ESP32 + BME280 (temperature, humidity, pressure)
// + SenseAir S8 (CO2) + TFT screen + Telegram bot. Publishes to the dashboard's MQTT broker on
// home/sensors/<ROOM>/<metric> as {"value": …, "ts": "…Z", "rssi": …} (docs/03 § room_sensors).
//
// Nothing blocks: Wi-Fi, MQTT and Telegram each reconnect in the background, so the screen and
// the bot keep working while any of them is down, and a missing sensor is reported, not fatal.
//
// Setup: copy secrets.example.h to secrets.h and fill it in; see README.md for the libraries.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <PubSubClient.h>
#include <UniversalTelegramBot.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <time.h>
#include "s8_uart.h"
#include "secrets.h"

// ---- Settings for this sensor ---------------------------------------------------------------

// The room, in snake_case: it becomes the topic home/sensors/<ROOM>/… and the name on the
// dashboard ("kitchen" → Kitchen).
#define ROOM "kitchen"
#define ROOM_TITLE "Kitchen"

// Which parts are fitted (1 = yes, 0 = no).
#define HAS_CO2 1
#define HAS_SCREEN 1

// Added to the BME280's temperature. Next to a warm ESP32 it often reads 1–2 °C high: compare
// with the Nest or another thermometer for an hour, then set e.g. -1.5. Humidity is corrected
// to match (relative humidity depends on temperature).
const float TEMP_OFFSET_C = 0.0;

const uint32_t PUBLISH_EVERY_MS = 30000;  // the dashboard expects a reading every 30 s
const uint32_t SENSORS_EVERY_MS = 2000;
const uint32_t TELEGRAM_EVERY_MS = 2000;
const uint32_t WIFI_RETRY_MS = 30000;

// Wiring.
#define BME280_ADDRESS 0x76  // 0x77 is tried as well
#define S8_RX_PIN 16         // ESP32 pin the S8's TX is attached to
#define S8_TX_PIN 17         // ESP32 pin the S8's RX is attached to
#define S8_UART_PORT 2
#define SCREEN_LED_PIN 5     // backlight: HIGH = on

// UK time, switching between GMT and BST by itself.
#define TIME_ZONE "GMT0BST,M3.5.0/1,M10.5.0"

// ---- State ----------------------------------------------------------------------------------

Adafruit_BME280 bme;
HardwareSerial s8Serial(S8_UART_PORT);
S8_UART *s8 = nullptr;
TFT_eSPI tft = TFT_eSPI();

WiFiClient mqttNet;
PubSubClient mqtt(mqttNet);
WiFiClientSecure telegramNet;
UniversalTelegramBot bot(TELEGRAM_BOT_TOKEN, telegramNet);

bool bmeOk = false;
bool s8Ok = false;
bool screenOn = true;

struct Readings {
  bool env = false;  // temperature, humidity, pressure valid
  float temperature = 0, humidity = 0, pressure = 0;
  bool co2Ok = false;
  int co2 = 0;
} latest;

uint32_t lastSensors = 0, lastPublish = 0, lastScreen = 0, lastTelegram = 0;
uint32_t lastWifiAttempt = 0, lastMqttAttempt = 0, mqttRetryMs = 5000;
bool wifiWasUp = false, everOnline = false, reconnectNotice = false, startupSent = false;
int dropTimes = 0, botMessages = 0;
unsigned long published = 0;
String startTime = "not yet";

// ---- Time -----------------------------------------------------------------------------------

bool timeIsSet() { return time(nullptr) > 1700000000; }  // after Nov 2023: NTP has answered

/** "2026-11-14T18:54:01Z" for the MQTT payload (UTC, as the dashboard stores it). */
void utcStamp(char *out, size_t size) {
  time_t t = time(nullptr);
  struct tm utc;
  gmtime_r(&t, &utc);
  strftime(out, size, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

/** "Saturday, November 14 2026 18:54:01" in UK time, for Telegram. */
String localTimeText() {
  struct tm local;
  if (!timeIsSet() || !getLocalTime(&local, 0)) return "unknown";
  char buf[64];
  strftime(buf, sizeof(buf), "%A, %B %d %Y %H:%M:%S", &local);
  return String(buf);
}

// ---- Sensors --------------------------------------------------------------------------------

/** Saturation vapour pressure (hPa), Magnus formula. */
float saturation(float c) { return 6.112f * expf(17.62f * c / (243.12f + c)); }

/** Relative humidity as it would read at the corrected temperature. */
float correctedHumidity(float measured, float rawC, float correctedC) {
  float rh = measured * saturation(rawC) / saturation(correctedC);
  return rh < 0 ? 0 : rh > 100 ? 100 : rh;
}

void readSensors() {
  if (bmeOk) {
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;
    latest.env = !isnan(t) && !isnan(h) && !isnan(p) && p > 300;
    if (latest.env) {
      latest.temperature = t + TEMP_OFFSET_C;
      latest.humidity = TEMP_OFFSET_C == 0 ? h : correctedHumidity(h, t, latest.temperature);
      latest.pressure = p;
    }
  }
  if (s8Ok) {
    int c = s8->get_co2();
    latest.co2Ok = c >= 300 && c <= 10000;  // 0 or nonsense means the reading failed
    if (latest.co2Ok) latest.co2 = c;
  }
}

// ---- MQTT -----------------------------------------------------------------------------------

/** One reading to home/sensors/<ROOM>/<metric>; the Wi-Fi signal rides along when asked. */
void publish(const char *metric, float value, int decimals, bool withRssi) {
  char topic[64];
  snprintf(topic, sizeof(topic), "home/sensors/%s/%s", ROOM, metric);
  char payload[128];
  int n = snprintf(payload, sizeof(payload), "{\"value\":%.*f", decimals, value);
  if (withRssi) n += snprintf(payload + n, sizeof(payload) - n, ",\"rssi\":%d", (int)WiFi.RSSI());
  if (timeIsSet()) {  // without NTP time, leave ts out: the dashboard uses the arrival time
    char ts[24];
    utcStamp(ts, sizeof(ts));
    n += snprintf(payload + n, sizeof(payload) - n, ",\"ts\":\"%s\"", ts);
  }
  snprintf(payload + n, sizeof(payload) - n, "}");
  if (mqtt.publish(topic, payload)) published++;
}

void publishReadings() {
  if (latest.env) {
    publish("temperature", latest.temperature, 2, true);
    publish("humidity", latest.humidity, 1, false);
    publish("pressure", latest.pressure, 1, false);
  }
  if (latest.co2Ok) publish("co2", latest.co2, 0, false);
}

/** One connection attempt at a time, backing off from 5 s to a minute while it fails. */
void serviceMqtt() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqtt.connected()) {
    mqtt.loop();
    return;
  }
  if (lastMqttAttempt != 0 && millis() - lastMqttAttempt < mqttRetryMs) return;
  lastMqttAttempt = millis();
  if (mqtt.connect("home-sensor-" ROOM, MQTT_USER, MQTT_PASSWORD)) {
    mqttRetryMs = 5000;
    Serial.println("MQTT connected");
  } else {
    mqttRetryMs = mqttRetryMs >= 30000 ? 60000 : mqttRetryMs * 2;
    Serial.printf("MQTT failed (state %d), next try in %lu s\n", mqtt.state(), (unsigned long)(mqttRetryMs / 1000));
  }
}

/** PubSubClient's state as words, for /connection. */
String mqttStatus() {
  switch (mqtt.state()) {
    case MQTT_CONNECTED: return "connected";
    case MQTT_CONNECT_BAD_CREDENTIALS:
    case MQTT_CONNECT_UNAUTHORIZED: return "refused the login (check MQTT_USER / MQTT_PASSWORD)";
    case MQTT_CONNECTION_TIMEOUT:
    case MQTT_CONNECT_FAILED: return "can't reach " MQTT_HOST;
    default: return "not connected (state " + String(mqtt.state()) + ")";
  }
}

// ---- Wi-Fi ----------------------------------------------------------------------------------

volatile uint8_t wifiFailReason = 0;  // from the last "disconnected" event
bool networksListed = false;

void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) wifiFailReason = info.wifi_sta_disconnected.reason;
}

/** Why the ESP32 couldn't join, in words (ESP-IDF wifi_err_reason_t codes). */
const char *wifiFailText(uint8_t reason) {
  switch (reason) {
    case 2: case 15: case 204: return "wrong password? (handshake failed)";
    case 202: return "wrong password (authentication failed)";
    case 201: return "network name not found: check WIFI_SSID (the ESP32 only sees 2.4 GHz)";
    case 210: case 211: return "network found, but its security mode isn't supported (WPA3-only?)";
    case 212: return "network found, but the signal is too weak";
    case 203: case 205: return "the router refused the connection";
    case 0: return "no answer yet";
    default: return "see ESP-IDF wifi_err_reason_t";
  }
}

/** Once, after the first failed attempt: every network in range, to compare with WIFI_SSID. */
void listNetworks() {
  int n = WiFi.scanNetworks();
  Serial.printf("Networks in range (%d):\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  \"%s\"  %d dBm  channel %d\n", WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i), (int)WiFi.channel(i));
  }
  WiFi.scanDelete();
}

void serviceWifi() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (!up && wifiWasUp) dropTimes++;
  if (up && !wifiWasUp) {
    Serial.print("Wi-Fi connected: ");
    Serial.println(WiFi.localIP());
    if (everOnline) reconnectNotice = true;
    everOnline = true;
  }
  if (!up && millis() - lastWifiAttempt >= WIFI_RETRY_MS) {
    lastWifiAttempt = millis();
    Serial.printf("Wi-Fi not connected to \"%s\": %s (reason %d). Retrying...\n", WIFI_SSID,
                  wifiFailText(wifiFailReason), (int)wifiFailReason);
    WiFi.disconnect();  // a scan can't run during a connection attempt
    if (!networksListed) {
      networksListed = true;
      delay(100);
      listNetworks();
    }
    WiFi.reconnect();
  }
  wifiWasUp = up;
}

// ---- Telegram -------------------------------------------------------------------------------

String readingsText() {
  String m;
  if (latest.env) {
    m += "Temperature: " + String(latest.temperature, 1) + " °C";
    if (TEMP_OFFSET_C != 0) m += " (offset " + String(TEMP_OFFSET_C, 1) + ")";
    m += "\nHumidity: " + String(latest.humidity, 0) + " %\n";
    m += "Pressure: " + String(latest.pressure, 0) + " hPa\n";
  } else {
    m += bmeOk ? "BME280: no valid reading\n" : "BME280: not found (check wiring)\n";
  }
  if (HAS_CO2) {
    m += latest.co2Ok ? "CO₂: " + String(latest.co2) + " ppm\n"
                   : String(s8Ok ? "CO₂: no valid reading\n" : "CO₂ sensor: not found\n");
  }
  return m;
}

String connectionText() {
  String m = "Network: " + String(WIFI_SSID) + "\n";
  m += "IP: " + WiFi.localIP().toString() + " · signal " + String(WiFi.RSSI()) + " dBm\n";
  m += "Live since: " + startTime + "\n";
  m += "Wi-Fi drops: " + String(dropTimes) + "\n";
  m += "Dashboard (MQTT): " + mqttStatus() + "\n";
  m += "Readings sent: " + String(published);
  return m;
}

void handleMessages(int count) {
  for (int i = 0; i < count; i++) {
    String chatId = bot.messages[i].chat_id;
    if (chatId != TELEGRAM_CHAT_ID) {
      bot.sendMessage(chatId, "Unauthorized user", "");
      continue;
    }
    String text = bot.messages[i].text;
    botMessages++;
    String reply;
    if (text == "/start" || text == "/help") {
      reply = "Welcome, " + bot.messages[i].from_name + ".\n" ROOM_TITLE " sensor commands:\n\n";
      reply += "/readings\n/connection\n/botStats\n/screen\n";
    } else if (text == "/readings") {
      reply = readingsText();
    } else if (text == "/connection") {
      reply = connectionText();
    } else if (text == "/botStats") {
      reply = "Bot live since: " + startTime + "\nMessages: " + String(botMessages);
    } else if (text == "/screen") {
      screenOn = !screenOn;
      digitalWrite(SCREEN_LED_PIN, screenOn ? HIGH : LOW);
      reply = String("Screen is ") + (screenOn ? "on!" : "off!");
    } else {
      reply = "I don't understand what you are trying to do! Try /help";
    }
    bot.sendMessage(chatId, reply, "");
  }
}

void serviceTelegram() {
  if (WiFi.status() != WL_CONNECTED || millis() - lastTelegram < TELEGRAM_EVERY_MS) return;
  // Announce the start once the clock is set (or after 20 s without it).
  if (!startupSent && (timeIsSet() || millis() > 20000)) {
    startTime = localTimeText();
    String m = ROOM_TITLE " sensor has been started!";
    if (!bmeOk) m += "\nWarning: BME280 not found (check wiring).";
    if (HAS_CO2 && !s8Ok) m += "\nWarning: CO₂ sensor not found.";
    startupSent = bot.sendMessage(TELEGRAM_CHAT_ID, m, "");
  }
  if (reconnectNotice && bot.sendMessage(TELEGRAM_CHAT_ID, ROOM_TITLE " sensor: Wi-Fi dropped but is now connected again!", "")) {
    reconnectNotice = false;
  }
  int count = bot.getUpdates(bot.last_message_received + 1);
  while (count) {
    handleMessages(count);
    count = bot.getUpdates(bot.last_message_received + 1);
  }
  lastTelegram = millis();
}

// ---- Screen ---------------------------------------------------------------------------------

#define METER_GREY 0x2104  // dark grey, 16-bit colour

// Meter colour schemes.
#define RED2RED 0
#define GREEN2GREEN 1
#define BLUE2BLUE 2
#define BLUE2RED 3
#define GREEN2RED 4
#define RED2GREEN 5

/** A 16-bit rainbow colour: 0 = blue … 127 = red. */
unsigned int rainbow(byte value) {
  byte red = 0, green = 0, blue = 0;
  byte quadrant = value / 32;
  if (quadrant == 0) { blue = 31; green = 2 * (value % 32); red = 0; }
  if (quadrant == 1) { blue = 31 - (value % 32); green = 63; red = 0; }
  if (quadrant == 2) { blue = 0; green = 63; red = value % 32; }
  if (quadrant == 3) { blue = 0; green = 63 - 2 * (value % 32); red = 31; }
  return (red << 11) + (green << 5) + blue;
}

/** A ring meter at (x, y) with radius r; returns the x of its right-hand side. */
int ringMeter(int value, int vmin, int vmax, int x, int y, int r, const char *units, byte scheme) {
  x += r;
  y += r;            // centre of the ring
  int w = r / 4;     // ring width
  int angle = 150;   // half the sweep (300 degrees)
  int textColour = 0;
  int v = map(value, vmin, vmax, -angle, angle);
  byte seg = 5, inc = 5;

  for (int i = -angle; i < angle; i += inc) {
    int colour;
    switch (scheme) {
      case RED2RED: colour = TFT_RED; break;
      case GREEN2GREEN: colour = TFT_GREEN; break;
      case BLUE2BLUE: colour = TFT_BLUE; break;
      case BLUE2RED: colour = rainbow(map(i, -angle, angle, 0, 127)); break;
      case GREEN2RED: colour = rainbow(map(i, -angle, angle, 63, 127)); break;
      case RED2GREEN: colour = rainbow(map(i, -angle, angle, 127, 63)); break;
      default: colour = TFT_BLUE; break;
    }
    float sx = cos((i - 90) * 0.0174532925), sy = sin((i - 90) * 0.0174532925);
    uint16_t x0 = sx * (r - w) + x, y0 = sy * (r - w) + y, x1 = sx * r + x, y1 = sy * r + y;
    float sx2 = cos((i + seg - 90) * 0.0174532925), sy2 = sin((i + seg - 90) * 0.0174532925);
    int x2 = sx2 * (r - w) + x, y2 = sy2 * (r - w) + y, x3 = sx2 * r + x, y3 = sy2 * r + y;
    if (i < v) {
      tft.fillTriangle(x0, y0, x1, y1, x2, y2, colour);
      tft.fillTriangle(x1, y1, x2, y2, x3, y3, colour);
      textColour = colour;
    } else {
      tft.fillTriangle(x0, y0, x1, y1, x2, y2, METER_GREY);
      tft.fillTriangle(x1, y1, x2, y2, x3, y3, METER_GREY);
    }
  }

  char buf[10];
  byte len = value > 999 ? 5 : 4;
  dtostrf(value, len, 0, buf);
  tft.setTextColor(textColour, TFT_BLACK);
  if (r > 84) tft.drawCentreString(buf, x - 5, y - 20, 6);
  else tft.drawCentreString(buf, x - 5, y - 20, 4);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  if (r > 84) tft.drawCentreString(units, x, y + 30, 4);
  else tft.drawCentreString(units, x, y + 5, 2);
  return x + r;
}

void drawScreen() {
  ringMeter(latest.temperature, -10, 45, 0, 5, 60, "degC", BLUE2RED);
  ringMeter(latest.humidity, 10, 100, 100, 100, 60, "pcnt", GREEN2GREEN);
  ringMeter(latest.co2, 400, 4000, 200, 5, 60, "cO2", GREEN2RED);
  ringMeter(latest.pressure, 800, 1200, 127, 15, 35, "hPa", BLUE2RED);
  ringMeter(botMessages, 0, 100, 5, 150, 40, "msgs", BLUE2BLUE);
  ringMeter(dropTimes, 0, 100, 230, 150, 40, "drops", BLUE2BLUE);
}

// ---- Setup and loop -------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n" ROOM_TITLE " sensor starting");

  if (HAS_SCREEN) {
    pinMode(SCREEN_LED_PIN, OUTPUT);
    digitalWrite(SCREEN_LED_PIN, HIGH);
    tft.begin();
    tft.setRotation(1);
    tft.fillScreen(TFT_BLACK);
  }

  bmeOk = bme.begin(BME280_ADDRESS) || bme.begin(0x77);
  if (!bmeOk) Serial.println("BME280 not found: check wiring (carrying on without it)");

  if (HAS_CO2) {
    s8Serial.begin(S8_BAUDRATE, SERIAL_8N1, S8_RX_PIN, S8_TX_PIN);
    s8 = new S8_UART(s8Serial);
    S8_sensor info;
    s8->get_firmware_version(info.firm_version);
    s8Ok = strlen(info.firm_version) > 0;
    if (!s8Ok) Serial.println("SenseAir S8 not found: check wiring (carrying on without it)");
  }

  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  Serial.printf("Joining Wi-Fi \"%s\"\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttempt = millis();
  configTzTime(TIME_ZONE, "pool.ntp.org", "time.google.com");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setSocketTimeout(3);  // seconds: a dead broker mustn't freeze the loop for long
  telegramNet.setCACert(TELEGRAM_CERTIFICATE_ROOT);
  bot.waitForResponse = 1500;

  readSensors();
}

void loop() {
  serviceWifi();
  serviceMqtt();

  if (millis() - lastSensors >= SENSORS_EVERY_MS) {
    lastSensors = millis();
    readSensors();
    if (HAS_SCREEN && screenOn) drawScreen();
  }
  if (mqtt.connected() && millis() - lastPublish >= PUBLISH_EVERY_MS) {
    lastPublish = millis();
    publishReadings();
  }
  serviceTelegram();
  delay(10);
}
