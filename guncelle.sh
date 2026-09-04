#!/bin/bash
# ---------------------------------------------------------------------------
# mecazicards for Spotify — tek komutla kur / güncelle
#
# Kullanımı (cihazda, SSH ile):
#     curl -fsSL -o /tmp/guncelle.sh \
#       https://raw.githubusercontent.com/mecaz/mecazicards_for_spotify/main/guncelle.sh \
#       && bash /tmp/guncelle.sh
#
#  -f bayrağı önemli: dosya yoksa GitHub HTML hata sayfası döndürüyor ve
#  "curl | bash" onu komut olarak çalıştırmaya kalkıyor.
#
# Ne yapıyor: kodu GitHub'dan çeker, izinleri düzeltir, eklentiyi kurar ve
# sonucu doğrular. Samba'ya kopyalamaya, chown/chmod uğraşmaya gerek kalmıyor.
#
# Kart eşleştirmelerin ve ayarların /data/mecazicards-yedek altında duruyor;
# bu script onlara DOKUNMUYOR.
# ---------------------------------------------------------------------------
set -u

REPO="https://github.com/mecaz/mecazicards_for_spotify.git"
SRC="/data/mecazicards-kaynak"
PLUGIN_CFG="/data/configuration/system_hardware/mecazicards_for_spotify/config.json"
YEDEK="/data/mecazicards-yedek/kullanici-ayarlari-yedegi.json"

renk() { printf '\n\033[1m%s\033[0m\n' "$1"; }
hata() { printf '\033[31mHATA: %s\033[0m\n' "$1" >&2; exit 1; }

# --- Ön kontroller -------------------------------------------------------
command -v git >/dev/null 2>&1 || hata "git kurulu değil. 'sudo apt-get install -y git' deneyin."
command -v volumio >/dev/null 2>&1 || hata "'volumio' komutu bulunamadı. Bu script Volumio cihazında çalıştırılmalı."

if [ "$(id -un)" = "root" ]; then
  hata "Bu script'i root olarak ÇALIŞTIRMAYIN. Normal 'volumio' kullanıcısıyla çalıştırın:
       volumio plugin install root olarak çağrılınca izin hatasıyla çöküyor."
fi

# --- Kurulum öncesi durum ------------------------------------------------
renk "1/5 · Mevcut durum"
if [ -f "$PLUGIN_CFG" ]; then
  KART=$(python3 -c "
import json
try:
    c = json.load(open('$PLUGIN_CFG'))
    print(len(json.loads(c['mappings']['value'])))
except Exception:
    print('?')" 2>/dev/null)
  echo "   Kurulu eklenti bulundu — $KART kart eşleştirmesi."
else
  echo "   Kurulu eklenti yok (ilk kurulum)."
fi
if [ -f "$YEDEK" ]; then
  echo "   Ayar yedeği yerinde: $YEDEK"
else
  echo "   NOT: Henüz ayar yedeği yok; kurulumdan sonra kendiliğinden oluşacak."
fi

# --- Kodu çek ------------------------------------------------------------
renk "2/5 · Kod GitHub'dan alınıyor"
if [ -d "$SRC/.git" ]; then
  cd "$SRC" || hata "$SRC dizinine girilemedi."
  git fetch --all --quiet || hata "GitHub'a erişilemedi. İnternet bağlantısını kontrol edin."
  git reset --hard origin/main --quiet || hata "Kod güncellenemedi."
  echo "   Güncellendi: $SRC"
else
  rm -rf "$SRC"
  git clone --quiet "$REPO" "$SRC" || hata "Depo klonlanamadı. İnternet bağlantısını kontrol edin."
  echo "   İndirildi: $SRC"
fi

cd "$SRC" || hata "$SRC dizinine girilemedi."
SURUM=$(grep '"version"' package.json | head -1 | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/')
echo "   Sürüm: $SURUM"

# --- İzinler -------------------------------------------------------------
renk "3/5 · İzinler düzeltiliyor"
chmod +x install.sh uninstall.sh ./*.py 2>/dev/null || true
sudo chown -R volumio:volumio "$SRC" 2>/dev/null || \
  echo "   UYARI: sahiplik düzeltilemedi (sudo yok olabilir), yine de denenecek."
echo "   Tamam."

# --- Kur -----------------------------------------------------------------
renk "4/5 · Eklenti kuruluyor"
echo "   (Volumio 'doğrulanmamış eklenti' uyarısı verecek — Yes deyin.)"
echo
volumio plugin install || hata "Kurulum başarısız oldu. Yukarıdaki çıktıya bakın."

# --- Doğrula -------------------------------------------------------------
renk "5/5 · Doğrulama"
sleep 3
KURULU=$(grep '"version"' /data/plugins/system_hardware/mecazicards_for_spotify/package.json 2>/dev/null \
         | head -1 | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/')
echo "   Kurulu sürüm      : ${KURULU:-BULUNAMADI}"
echo "   go-librespot açılış: $(systemctl is-enabled go-librespot-daemon 2>/dev/null || echo '?')"
echo "   go-librespot durum : $(systemctl is-active go-librespot-daemon 2>/dev/null || echo '?')"
if [ -f "$YEDEK" ]; then
  echo "   Ayar yedeği       : var ($(stat -c '%U %a' "$YEDEK" 2>/dev/null))"
else
  echo "   Ayar yedeği       : henüz yok (eklenti çalışınca oluşacak)"
fi

renk "Bitti."
cat <<'SON'
Sırada:
  1. Volumio arayüzü → Plugins → mecazicards for Spotify → etkinleştir
  2. Galeri: http://mecaziradio.local:3500
  3. Kartların görünmüyorsa: galeri → Yedekle / Geri Yükle → yedek dosyasını yükle

Sorun çıkarsa:  sudo journalctl -u volumio -b --no-pager | grep mecazicards
SON
