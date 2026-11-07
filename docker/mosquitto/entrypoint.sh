#!/bin/sh
# Builds the Mosquitto password and ACL files from environment variables, then starts
# the broker through the image's own entrypoint.
set -eu

: "${MQTT_USERNAME:?MQTT_USERNAME must be set}"
: "${MQTT_PASSWORD:?MQTT_PASSWORD must be set}"
: "${MQTT_SENSOR_USERNAME:?MQTT_SENSOR_USERNAME must be set}"
: "${MQTT_SENSOR_PASSWORD:?MQTT_SENSOR_PASSWORD must be set}"

auth=/mosquitto/auth
mkdir -p "$auth"
rm -f "$auth/passwd"
touch "$auth/passwd"
chmod 0600 "$auth/passwd"
mosquitto_passwd -b "$auth/passwd" "$MQTT_USERNAME" "$MQTT_PASSWORD"
mosquitto_passwd -b "$auth/passwd" "$MQTT_SENSOR_USERNAME" "$MQTT_SENSOR_PASSWORD"

cat > "$auth/acl" <<ACL
# collector: reads everything under home/ and broker stats (healthcheck)
user $MQTT_USERNAME
topic readwrite home/#
topic read \$SYS/#

# sensors: may only publish readings (home/sensors/<entity>/<metric>)
user $MQTT_SENSOR_USERNAME
topic write home/sensors/#
ACL
chmod 0600 "$auth/acl"
chown -R mosquitto:mosquitto "$auth" /mosquitto/data

exec /docker-entrypoint.sh mosquitto -c /mosquitto/config/mosquitto.conf
