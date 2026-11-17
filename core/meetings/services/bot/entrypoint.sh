#!/bin/bash
# @vexa/bot entrypoint — bring up the X11 + PulseAudio environment the browser /
# capture / speak path expects, then run the worker (boot → join → ... → die).
#
# Mirrors the production bot's meeting-mode bringup (services/vexa-bot/core/
# entrypoint.sh), trimmed to what the v0.12 carved bot needs:
#   • Xvfb on :99           — a display for the headful Chromium @vexa/remote-browser launches.
#   • fluxbox               — a WM so the browser window manages cleanly.
#   • PulseAudio            : the audio graph, meeting_out (the browser's output, a dead end)
#                             and tts_sink → virtual_mic (speak), kept apart.
# The worker itself reads VEXA_BOT_CONFIG (invocation.v1) and drives the rest.
set -u

export DISPLAY="${DISPLAY:-:99}"

echo "[entrypoint] Starting Xvfb on ${DISPLAY}..."
Xvfb "${DISPLAY}" -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 &
# Give Xvfb a moment to create the socket before anything attaches.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
  sleep 0.3
done

echo "[entrypoint] Starting fluxbox..."
fluxbox >/tmp/fluxbox.log 2>&1 &

echo "[entrypoint] Starting PulseAudio (no idle exit)..."
pulseaudio --start --exit-idle-time=-1 --log-target=syslog 2>/dev/null || true
sleep 1
# The audio graph has two separate devices, and nothing connects them:
#   meeting_out  the DEFAULT sink: everything the browser plays (the meeting's incoming audio)
#                ends here and goes nowhere. The capture reads meeting audio in the page, not here.
#   tts_sink     only the speak path plays into it (paplay --device=tts_sink); its monitor,
#                remapped as virtual_mic, is the DEFAULT source, so it is the browser's microphone.
# The browser's output must never be the sink whose monitor is the microphone: the meeting would
# hear itself through the bot whenever the bot speaks. PulseAudio drops its automatic null sink as
# soon as another sink is loaded, so the default sink is named here, never left to chance.
# 48 kHz mono end to end: the browser opens the microphone at 48 kHz and the TTS clip is 24 kHz
# mono, so the only rate conversion is one exact 1:2 step.
pactl load-module module-null-sink sink_name=meeting_out rate=48000 \
  sink_properties=device.description="MeetingAudioOut" 2>/dev/null || true
pactl load-module module-null-sink sink_name=tts_sink rate=48000 channels=1 channel_map=mono \
  sink_properties=device.description="TTSAudioSink" 2>/dev/null || true
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic \
  channels=1 channel_map=mono master_channel_map=mono \
  source_properties=device.description="VirtualMicrophone" 2>/dev/null || true
# A build of PulseAudio that refuses the mono arguments still gets a microphone.
if ! pactl list short sources 2>/dev/null | grep -q 'virtual_mic'; then
  pactl list short sinks 2>/dev/null | grep -q 'tts_sink' \
    || pactl load-module module-null-sink sink_name=tts_sink \
         sink_properties=device.description="TTSAudioSink" 2>/dev/null || true
  pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic \
    source_properties=device.description="VirtualMicrophone" 2>/dev/null || true
fi
pactl set-default-sink meeting_out 2>/dev/null || true
pactl set-default-source virtual_mic 2>/dev/null || true
# Silent at rest by muting tts_sink only. Never mute virtual_mic: Meet shows a muted source as
# "Microphone problem" instead of the mic toggle, and a voice bot can then never speak.
pactl set-sink-mute tts_sink 1 2>/dev/null || true
# One line of the graph in the log, so a wrong default is visible without a shell in the container.
echo "[entrypoint] audio graph: default-sink=$(pactl get-default-sink 2>/dev/null || echo '?') default-source=$(pactl get-default-source 2>/dev/null || echo '?') sinks=$(pactl list short sinks 2>/dev/null | awk '{print $2}' | paste -sd, -)"

# CORPORATE TLS INSPECTION (chart global.extraCA → VEXA_EXTRA_CA_FILE): Chromium on Linux trusts
# only its NSS store, never SSL_CERT_FILE, so a page re-signed by the operator's root CA fails with
# ERR_CERT_AUTHORITY_INVALID unless that CA is in $HOME/.pki/nssdb. Import every certificate in the
# PEM (certutil -A takes one per call). Node, curl and the AWS CLI read the env the runtime sets.
if [ -n "${VEXA_EXTRA_CA_FILE:-}" ] && [ -s "${VEXA_EXTRA_CA_FILE}" ]; then
  NSSDB="${HOME:-/tmp}/.pki/nssdb"
  CA_SPLIT="$(mktemp -d)"
  if mkdir -p "${NSSDB}" \
     && { [ -f "${NSSDB}/cert9.db" ] || certutil -d "sql:${NSSDB}" -N --empty-password; } \
     && awk -v d="${CA_SPLIT}" '/-----BEGIN CERTIFICATE-----/{n++; f=sprintf("%s/%03d.pem", d, n)} n&&f{print > f} /-----END CERTIFICATE-----/{close(f); f=""}' "${VEXA_EXTRA_CA_FILE}"; then
    CA_N=0
    for CA_PEM in "${CA_SPLIT}"/*.pem; do
      [ -s "${CA_PEM}" ] || continue
      CA_N=$((CA_N + 1))
      certutil -d "sql:${NSSDB}" -A -t "C,," -n "vexa-extra-ca-${CA_N}" -i "${CA_PEM}" || echo "[entrypoint] WARNING: certutil refused ${CA_PEM##*/}"
    done
    echo "[entrypoint] Chromium trusts ${CA_N} extra CA certificate(s) from ${VEXA_EXTRA_CA_FILE}"
  else
    echo "[entrypoint] WARNING: could not import ${VEXA_EXTRA_CA_FILE} into Chromium's NSS store"
  fi
  rm -rf "${CA_SPLIT}"
fi

# Run the worker from its package dir so the schema path (src→../../../contracts)
# and the pnpm-linked workspace deps resolve. Always emit start + exit breadcrumbs
# so an instant crash is never silent in container stdout.
# BOT_APP_DIR/BOT_WORKER_ENTRY are overridable so the entrypoint's signal handling is
# unit-testable outside the image (entrypoint.test.ts drives a stub worker through it).
cd "${BOT_APP_DIR:-/app/core/meetings/services/bot}" || exit 1
echo "[entrypoint] Starting @vexa/bot worker (node dist/index.js, DISPLAY=${DISPLAY})..."

# SIGNAL FORWARDING (the exit-137 fix): this script is PID 1, and a PID-1 bash neither dies on
# SIGTERM nor passes it to a foreground child — so `docker stop` (and the runtime's graceful
# terminate) reached NOBODY, every stop escalated to SIGKILL (exit 137) mid-capture, and the
# bot's graceful leave (leave meeting → flush recording → terminal lifecycle callback → exit 0,
# bounded <25s by its own watchdog) never ran. Run the worker in the background and FORWARD
# TERM/INT to it; wait() resumes on the trap (128+N) so loop until the worker really exits.
node "${BOT_WORKER_ENTRY:-dist/index.js}" &
WORKER_PID=$!
trap 'kill -TERM "${WORKER_PID}" 2>/dev/null' TERM
trap 'kill -INT "${WORKER_PID}" 2>/dev/null' INT
wait "${WORKER_PID}"
EXIT_CODE=$?
while kill -0 "${WORKER_PID}" 2>/dev/null; do
  wait "${WORKER_PID}"
  EXIT_CODE=$?
done
echo "[entrypoint] @vexa/bot worker exited with code ${EXIT_CODE}"
exit ${EXIT_CODE}
