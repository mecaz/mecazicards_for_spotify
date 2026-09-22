#!/bin/bash
# ---------------------------------------------------------------------------
# mecazicards for Spotify: GitHub'dan kurulum/güncelleme.
#
#     curl -fsSL -o /tmp/guncelle.sh \
#       https://raw.githubusercontent.com/mecaz/mecazicards_for_spotify/main/guncelle.sh \
#       && bash /tmp/guncelle.sh
#
# -f bayrağı önemli: dosya yoksa GitHub HTML hata sayfası döndürüyor ve
# "curl | bash" onu komut olarak çalıştırmaya kalkıyor.
#
# Kodu indirir ve yerel kurulumla AYNI kurucuyu (kur.sh) çalıştırır. Önceki
# sürümü bu betik "volumio plugin install" ile kuruyordu; eklenti zaten
# kuruluysa Volumio bunu reddediyor, önce kaldırmak gerekiyordu. kur.sh
# kuruluysa yerinde güncelliyor.
# ---------------------------------------------------------------------------
set -e
DEPO="${MECAZICARDS_DEPO:-https://github.com/mecaz/mecazicards_for_spotify}"
DAL="${MECAZICARDS_DAL:-main}"
HEDEF=/home/volumio/.mecazicards-gelen
rm -rf "$HEDEF"
git clone -q --depth 1 --branch "$DAL" "$DEPO" "$HEDEF" || { echo "İndirilemedi: $DEPO"; exit 1; }
exec bash "$HEDEF/kur.sh" "$HEDEF"
