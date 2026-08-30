#!/bin/bash

echo "mecazicards_for_spotify kaldırılıyor..."

rm -f /etc/udev/rules.d/99-mecazicards.rules
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

# go-librespot açılış düzelticisini (systemd drop-in) kaldır - eklentiden
# geriye iz kalmasın. config.yml'e dokunmuyoruz; Volumio zaten ilk açılışta
# onu kendi ayarlarından yeniden üretiyor.
LIBRESPOT_DROPIN_DIR="/etc/systemd/system/go-librespot-daemon.service.d"
LIBRESPOT_DROPIN="$LIBRESPOT_DROPIN_DIR/mecazicards.conf"
LIBRESPOT_STATE_FILE="$LIBRESPOT_DROPIN_DIR/mecazicards-prior-enable-state"

# Servisi kurulum ÖNCESİNDEKİ enable/disable durumuna geri döndür. Kurarken
# 'disabled' bulup biz etkinleştirdiysek, kaldırırken geri kapatıyoruz.
# Kurulumdan önce zaten 'enabled' idiyse dokunmuyoruz - o Volumio'nun kendi
# tercihiydi, bizim geri alacağımız bir şey değil.
if [ -f "$LIBRESPOT_STATE_FILE" ]; then
  PRIOR_STATE="$(tr -d '[:space:]' < "$LIBRESPOT_STATE_FILE" 2>/dev/null)"
  if [ "$PRIOR_STATE" = "disabled" ]; then
    echo "go-librespot servisi kurulumdan önce 'disabled' idi, o hâline döndürülüyor..."
    systemctl disable go-librespot-daemon 2>/dev/null || true
  else
    echo "go-librespot servisinin enable durumuna dokunulmadı (kurulum öncesi: ${PRIOR_STATE:-bilinmiyor})."
  fi
  rm -f "$LIBRESPOT_STATE_FILE"
fi

if [ -f "$LIBRESPOT_DROPIN" ]; then
  echo "go-librespot açılış düzelticisi kaldırılıyor..."
  rm -f "$LIBRESPOT_DROPIN"
fi

rmdir "$LIBRESPOT_DROPIN_DIR" 2>/dev/null || true
systemctl daemon-reload 2>/dev/null || true
systemctl restart go-librespot-daemon 2>/dev/null || true

echo "mecazicards_for_spotify kaldırıldı."

# Volumio Plugin Manager kaldırmanın bittiğini bu satırla anlıyor - SİLME.
echo "pluginuninstallend"
