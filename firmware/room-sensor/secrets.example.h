// Copy this file to secrets.h (same folder) and fill it in. secrets.h is git-ignored:
// it must never be committed (the repo is public).

#pragma once

// Home Wi-Fi.
#define WIFI_SSID "your-network-name"
#define WIFI_PASSWORD "your-wifi-password"

// The Raspberry Pi's address and the sensors' MQTT login: on the Pi, run
//   grep '^MQTT_SENSOR_' /opt/home-dashboard/.env
#define MQTT_HOST "192.168.1.36"
#define MQTT_PORT 1883
#define MQTT_USER "sensors"
#define MQTT_PASSWORD "the-MQTT_SENSOR_PASSWORD-value"

// Telegram bot (from @BotFather) and the one chat allowed to use it.
#define TELEGRAM_BOT_TOKEN "123456789:replace-me"
#define TELEGRAM_CHAT_ID "123456789"
