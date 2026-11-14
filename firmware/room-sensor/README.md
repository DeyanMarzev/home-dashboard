# Room sensor (ESP32)

ESP32 + BME280 (temperature, humidity, pressure) + SenseAir S8 (CO₂) + TFT screen + Telegram
bot. Every 30 s it publishes to the dashboard's MQTT broker on the Pi:

```
home/sensors/kitchen/temperature   {"value":21.43,"rssi":-58,"ts":"2026-11-14T18:54:01Z"}
home/sensors/kitchen/humidity      {"value":48.2,"ts":"…"}
home/sensors/kitchen/pressure      {"value":1012.6,"ts":"…"}
home/sensors/kitchen/co2           {"value":612,"ts":"…"}
```

That's the contract in `docs/03` § room_sensors: the dashboard needs nothing else.

## Settings

At the top of `room-sensor.ino`:

| Setting | |
|---|---|
| `ROOM`, `ROOM_TITLE` | `kitchen` / `Kitchen`. For another room, copy the sketch folder and change these (snake_case for `ROOM`: `living_room`). |
| `HAS_CO2`, `HAS_SCREEN` | 1 if fitted, 0 if not. |
| `TEMP_OFFSET_C` | Added to the temperature. A BME280 next to a warm ESP32 often reads 1–2 °C high: compare with the Nest for an hour and set e.g. `-1.5`. Humidity is corrected to match. |
| Pins | S8 on UART2 (RX 16, TX 17), BME280 on I²C at 0x76 (0x77 also tried), screen backlight on pin 5. |

Secrets go in `secrets.h`, which git ignores (the repo is public): copy `secrets.example.h`
to `secrets.h` and fill it in. The MQTT login is the sensors' user from the Pi's `.env`:

```bash
grep '^MQTT_SENSOR_' /opt/home-dashboard/.env
```

That user may only publish to `home/sensors/#`.

## Building (Arduino IDE)

- Board: **ESP32 Dev Module** (or your board). Boards Manager: "esp32" by Espressif.
- Libraries (Library Manager): **Adafruit BME280 Library**, **Adafruit Unified Sensor**,
  **PubSubClient** (Nick O'Leary), **UniversalTelegramBot** (Brian Lough), **ArduinoJson**,
  **TFT_eSPI** (Bodmer), and **S8_UART** (Josep Comas) for `s8_uart.h`.
- TFT_eSPI takes its display driver and pins from its own `User_Setup.h` in the library
  folder: keep the one you already use for this screen.
- Upload, then open the Serial Monitor at 115200 baud: it prints the Wi-Fi address and
  "MQTT connected".

## Telegram

`/readings`, `/connection` (Wi-Fi, signal, drops, whether the dashboard connection works,
readings sent), `/botStats`, `/screen` (backlight on/off), `/help`. Only `TELEGRAM_CHAT_ID`
may use it. It announces itself on start (with a warning if a sensor isn't found) and after
Wi-Fi comes back.

## Behaviour

Nothing blocks: Wi-Fi retries every 30 s, MQTT backs off from 5 s to a minute, Telegram polls
every 2 s only while online. The screen and the bot keep working while the dashboard is
unreachable, and a missing BME280 or S8 is reported instead of stopping the device. The clock
is UK time (GMT/BST) from NTP; readings carry a UTC timestamp once it's set, and none before
(the dashboard then uses the arrival time).
