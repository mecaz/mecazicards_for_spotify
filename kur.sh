#!/bin/bash
# ---------------------------------------------------------------------------
# mecazicards for Spotify kurucu. İlk kurulum da güncelleme de bu; eski sürümü
# kaldırmana gerek yok, izinleri de kendisi düzeltir.
#
#   mecazicards-kur            /mnt/INTERNAL'daki en yeni mecazicards klasörü ya da zip'i
#   mecazicards-kur /yol       belirli bir klasör ya da zip
#
# İlk seferde komut henüz kurulu olmadığı için: bash /mnt/INTERNAL/<klasör>/kur.sh
#
# Kart eşleştirmelerine ve ayarlarına DOKUNMAZ: eklentiyi kaldırıp kurmuyor
# (Volumio kaldırırken ayar klasörünü siliyor), yalnızca eklenti dosyalarını
# yerinde değiştiriyor. Kart sayısını önce ve sonra gösterip karşılaştırır.
# ---------------------------------------------------------------------------
set -e
PLUGIN=/data/plugins/system_hardware/mecazicards_for_spotify
CFG=/data/configuration/system_hardware/mecazicards_for_spotify/config.json
WORK=/home/volumio/.mecazicards-kur
ESKI_KAYNAK=/data/mecazicards-kaynak
PLUGINS_JSON=/data/configuration/plugins.json

renk() { printf '\n\033[1;33m%s\033[0m\n' "$*"; }
iyi()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
hata() { printf '\n\033[1;31mHATA: %s\033[0m\n' "$*"; exit 1; }
surum() { grep -o '"version": *"[^"]*"' "$1" 2>/dev/null | head -1 | cut -d'"' -f4; }
kart_sayisi() {
  python3 - "$CFG" <<'PY' 2>/dev/null || echo "?"
import json, sys
try:
    c = json.load(open(sys.argv[1]))
    print(len(json.loads(c['mappings']['value'])))
except FileNotFoundError:
    print(0)
PY
}
port() {
  python3 - "$CFG" <<'PY' 2>/dev/null || echo 3500
import json, sys
try: print(int(json.load(open(sys.argv[1]))['web_ui_port']['value']))
except Exception: print(3500)
PY
}

[ "$(id -un)" = "volumio" ] || hata "volumio kullanıcısıyla çalıştır (sudo'suz). volumio plugin install root olarak çağrılınca izin hatasıyla çöküyor."

# ---- 1. Kaynak ------------------------------------------------------------
KAYNAK="$1"
if [ -z "$KAYNAK" ]; then
  KAYNAK=$(ls -td /mnt/INTERNAL/mecazicards* 2>/dev/null | head -1)
  [ -n "$KAYNAK" ] || hata "/mnt/INTERNAL içinde mecazicards klasörü ya da zip'i yok."
fi
[ -e "$KAYNAK" ] || hata "$KAYNAK bulunamadı."

GECICI=""
if [ -f "$KAYNAK" ]; then
  GECICI=$(mktemp -d)
  unzip -q "$KAYNAK" -d "$GECICI" || hata "$KAYNAK açılamadı."
  KAYNAK="$GECICI"
fi
if [ ! -f "$KAYNAK/package.json" ]; then
  ALT=$(ls -d "$KAYNAK"/*/ 2>/dev/null | head -1)
  [ -n "$ALT" ] && [ -f "$ALT/package.json" ] && KAYNAK="${ALT%/}"
fi
grep -q '"name": *"mecazicards_for_spotify"' "$KAYNAK/package.json" 2>/dev/null \
  || hata "$KAYNAK bir mecazicards paketi değil."

YENI=$(surum "$KAYNAK/package.json")
ESKI=$(surum "$PLUGIN/package.json")
ONCE=$(kart_sayisi)
renk "mecazicards  ${ESKI:-kurulu değil}  ->  $YENI"
echo "Kaynak: $KAYNAK"
echo "Kart eşleştirmesi: $ONCE"

# ---- 2. Çalışma klasörü ---------------------------------------------------
renk "1/4 Dosyalar hazırlanıyor"
rm -rf "$WORK"; mkdir -p "$WORK"
sudo rsync -a --exclude node_modules --exclude .git --exclude .DS_Store --exclude '._*' "$KAYNAK/" "$WORK/"
sudo chown -R volumio:volumio "$WORK"
chmod +x "$WORK"/*.sh "$WORK"/*.py 2>/dev/null || true
if [ -n "$GECICI" ]; then rm -rf "$GECICI"; fi

# Kullanıcının kendi logoları (README'deki "kendi logonu koy" dosyaları) pakette
# yoksa kurulu eklentiden taşı
if [ -d "$PLUGIN/web" ]; then
  for f in "$PLUGIN"/web/*; do
    [ -e "$WORK/web/$(basename "$f")" ] || cp -a "$f" "$WORK/web/"
  done
fi

# ---- 3. Node bağımlılıkları ----------------------------------------------
renk "2/4 Node bağımlılıkları"
ayni_bagimlilik() {
  [ -d "$PLUGIN/node_modules" ] || return 1
  python3 - "$PLUGIN/package.json" "$WORK/package.json" <<'PY'
import json, sys
a, b = (json.load(open(p)).get('dependencies', {}) for p in sys.argv[1:3])
sys.exit(0 if a == b else 1)
PY
}
if ayni_bagimlilik; then
  cp -a "$PLUGIN/node_modules" "$WORK/"
  echo "Değişmemiş, mevcutlar kullanılıyor."
else
  (cd "$WORK" && npm install --omit=dev --no-audit --no-fund --loglevel=error) \
    || hata "npm install başarısız. İnternet bağlantısını kontrol et."
fi

# ---- 4. Kur ya da güncelle ------------------------------------------------
BASLA=$(date '+%Y-%m-%d %H:%M:%S')
if [ -d "$PLUGIN" ]; then
  renk "3/4 Kurulu eklenti güncelleniyor"
  sudo systemctl stop volumio
  sudo rsync -a --delete "$WORK/" "$PLUGIN/"
  sudo chown -R volumio:volumio "$PLUGIN"
  # udev kuralları, go-librespot ayarı, yedek koruması (tekrar çalıştırmak güvenli)
  (cd "$PLUGIN" && sudo bash install.sh) | grep -vE "plugininstallend|etkinleştirmeyi unutma" || true
else
  renk "3/4 Volumio'ya kuruluyor (gelen soruya Yes de)"
  (cd "$WORK" && volumio plugin install) || hata "volumio plugin install başarısız."
  sudo systemctl stop volumio
fi

if [ -f "$PLUGINS_JSON" ]; then
  sudo python3 - "$PLUGINS_JSON" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
e = d.setdefault('system_hardware', {}).setdefault('mecazicards_for_spotify', {})
e['enabled'] = {'type': 'boolean', 'value': True}
e['status'] = {'type': 'string', 'value': 'STARTED'}
json.dump(d, open(p, 'w'), indent=2)
PYEOF
fi

# ---- 5. Başlat ve doğrula -------------------------------------------------
renk "4/4 Volumio başlatılıyor ve eklenti doğrulanıyor (1-2 dk)"
sudo systemctl start volumio
P=$(port)
TAMAM=""
for _ in $(seq 1 60); do
  if curl -fs --max-time 2 "http://127.0.0.1:$P/api/state" >/dev/null 2>&1; then TAMAM=1; break; fi
  sleep 3; printf '.'
done
echo

sudo install -m 0755 "$PLUGIN/kur.sh" /usr/local/bin/mecazicards-kur 2>/dev/null || true
rm -rf "$WORK" /home/volumio/.mecazicards-gelen
# Eski guncelle.sh'ın kalıcı kaynak klasörü artık gerekmiyor
if [ -d "$ESKI_KAYNAK" ]; then sudo rm -rf "$ESKI_KAYNAK"; echo "Eski $ESKI_KAYNAK temizlendi."; fi

SONRA=$(kart_sayisi)
if [ -n "$TAMAM" ]; then
  iyi "Tamam: mecazicards $(surum "$PLUGIN/package.json") çalışıyor.  Galeri: http://mecaziradio.local:$P"
  if [ "$ONCE" != "?" ] && [ "$SONRA" != "?" ] && [ "$SONRA" -lt "$ONCE" ] 2>/dev/null; then
    printf '\033[1;31mDİKKAT: kart eşleştirmesi %s -> %s oldu! Galeri -> Yedekle / Geri Yükle ile /data/mecazicards-yedek yedeğini yükle.\033[0m\n' "$ONCE" "$SONRA"
  else
    echo "Kart eşleştirmesi: $SONRA (öncesi: $ONCE)"
  fi
  echo "Sonraki güncellemeler için: mecazicards-kur"
else
  printf '\n\033[1;31mEklenti açılmadı. Volumio logundaki ilgili satırlar:\033[0m\n'
  sudo journalctl -u volumio --since "$BASLA" --no-pager | grep -i "mecazicards" | tail -30
  exit 1
fi
