#!/bin/bash

echo "mecazicards_for_spotify eklentisi kuruluyor..."

INSTALLING_DIR=$(pwd)

# Sycreader RFID Technology Co., Ltd SYC ID&IC USB Reader
HID_VENDOR="08ff"
HID_PRODUCT="0009"
UDEV_RULE_FILE="/etc/udev/rules.d/99-mecazicards.rules"

# -------------------------------------------------------
# 0. KULLANICI AYARLARINI KURTAR (her şeyden önce)
#
# Volumio, eklenti güncellemesinde çalışma config'ini paketin içindeki
# config.json ile ezebiliyor. v3.12.0'da paketteki şablon boş olduğu için bu
# 148 kartlık eşleştirme listesini sildi.
#
# Bu yüzden kuruluma başlamadan ÖNCE mevcut eşleştirmelerin ayrı bir kopyasını
# alıyoruz. Eklenti açılışta config'i boş bulursa bu kopyadan geri yüklüyor.
# Kopya paketin içinde olmadığı için güncelleme onu ezemiyor.
# -------------------------------------------------------
RUNTIME_CFG="/data/configuration/system_hardware/mecazicards_for_spotify/config.json"
SAFETY_COPY="/data/configuration/system_hardware/mecazicards_for_spotify/kullanici-ayarlari-yedegi.json"
if [ -f "$RUNTIME_CFG" ]; then
  python3 - "$RUNTIME_CFG" "$SAFETY_COPY" <<'SAFETYEOF' 2>/dev/null || true
import json, sys, datetime
cfg_path, out_path = sys.argv[1], sys.argv[2]
KEYS = ['mappings','resolved_names','play_stats','custom_info',
        'spotify_client_id','spotify_client_secret','spotify_refresh_token',
        'spotify_connect_device_name','playback_mode','gallery_sort',
        'last_played_card_id','hid_device_path','input_event_device_path','web_ui_port']
def bos(v):
    return v is None or str(v).strip() in ('', '{}')
try:
    cfg = json.load(open(cfg_path, encoding='utf-8'))
except Exception:
    sys.exit(0)
vals = {}
for k in KEYS:
    v = (cfg.get(k) or {}).get('value')
    if not bos(v):
        vals[k] = v
if bos(vals.get('mappings')):
    sys.exit(0)                      # boş/ezilmiş config yedeği bozmasın
try:
    eski = json.load(open(out_path, encoding='utf-8')).get('values') or {}
    if len(json.loads(eski.get('mappings') or '{}')) > len(json.loads(vals['mappings'])):
        sys.exit(0)                  # daha az kartla üzerine yazma
except Exception:
    pass
json.dump({'savedAt': datetime.datetime.now().isoformat(), 'values': vals},
          open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('[mecazicards] %d kart ve %d ayar güvenceye alındı.'
      % (len(json.loads(vals['mappings'])), len(vals)))
SAFETYEOF
  chown volumio:volumio "$SAFETY_COPY" 2>/dev/null || true
  chmod 600 "$SAFETY_COPY" 2>/dev/null || true
fi

# -------------------------------------------------------
# 1. Eski bağımsız (systemd tabanlı) kurulumu temizle
#    - install_mecazicards_for_spotify_v3.sh ile kurulmuş olabilir
# -------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q '^mecazicards.service'; then
  echo "Eski bağımsız 'mecazicards' servisi bulundu, durduruluyor ve kaldırılıyor..."
  systemctl stop mecazicards.service 2>/dev/null || true
  systemctl disable mecazicards.service 2>/dev/null || true
  rm -f /etc/systemd/system/mecazicards.service
  systemctl daemon-reload
  echo "Eski servis kaldırıldı."
fi

if [ -d "/opt/mecazicards_for_spotify" ]; then
  echo "NOT: Eski kurulum dizini /opt/mecazicards_for_spotify hâlâ duruyor."
  echo "     Kart eşleştirmelerin bu eklentiye otomatik taşındı, istersen o dizini elle silebilirsin."
fi

# -------------------------------------------------------
# 2. Node bağımlılıkları
#    Volumio zip'i oluştururken node_modules'ı zaten paketin içine
#    gömüyor, o yüzden burada sadece EKSİKSE kuruyoruz - ve ağ
#    sorunlarında (npm registry'ye erişilemiyorsa) script'in
#    sonsuza kadar takılı kalmaması için 60 saniyelik zaman aşımı
#    koyuyoruz. Kurulum takılıp kalıyordu, bunun sebebi muhtemelen
#    tam da buydu.
# -------------------------------------------------------
cd "$INSTALLING_DIR"
if [ ! -d "node_modules" ] || [ -z "$(ls -A node_modules 2>/dev/null)" ]; then
  echo "node_modules bulunamadı, kuruluyor (en fazla 60sn beklenecek)..."
  timeout 60 npm install --production --no-audit --no-fund --silent
  if [ $? -ne 0 ]; then
    echo "UYARI: npm install başarısız oldu veya zaman aşımına uğradı. Kuruluma devam ediliyor,"
    echo "       ama eklenti çalışmayabilir. SSH ile bağlanıp elle 'npm install --production'"
    echo "       çalıştırıp ağ/DNS durumunu kontrol etmen gerekebilir."
  fi
else
  echo "node_modules zaten mevcut, npm install atlanıyor."
fi

# -------------------------------------------------------
# 3. udev kuralları - Sycreader RFID (08ff:0009) sabit symlink'ler
#    - mecazicards_hid   : ham HID raporları (eklentinin okuduğu)
#    - mecazicards_input : aynı cihazın standart klavye (evdev) arayüzü.
#      Bu, triggerhappy'nin (thd) kart okutunca gelen "Enter" tuşunu
#      play/pause sanıp devreye girmesini engellemek için eklentinin
#      exclusive grab (EVIOCGRAB) uygulayacağı düğüm.
# -------------------------------------------------------
echo "udev kuralları yazılıyor: $UDEV_RULE_FILE"

cat > "$UDEV_RULE_FILE" << UDEVEOF
# mecazicards_for_spotify
# Sycreader RFID Technology Co., Ltd SYC ID&IC USB Reader (${HID_VENDOR}:${HID_PRODUCT})
# Sabit symlink'ler: /dev/mecazicards_hid ve /dev/mecazicards_input
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="${HID_VENDOR}", ATTRS{idProduct}=="${HID_PRODUCT}", SYMLINK+="mecazicards_hid", MODE="0666"
SUBSYSTEM=="input", KERNEL=="event*", ATTRS{idVendor}=="${HID_VENDOR}", ATTRS{idProduct}=="${HID_PRODUCT}", SYMLINK+="mecazicards_input", MODE="0666"
UDEVEOF

udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

sleep 1
if [ -e "/dev/mecazicards_hid" ]; then
  echo "Symlink hazır: /dev/mecazicards_hid -> $(readlink /dev/mecazicards_hid)"
else
  echo "UYARI: /dev/mecazicards_hid henüz oluşmadı. Okuyucu takılı değilse, takınca otomatik oluşacak."
fi
if [ -e "/dev/mecazicards_input" ]; then
  echo "Symlink hazır: /dev/mecazicards_input -> $(readlink /dev/mecazicards_input)"
else
  echo "UYARI: /dev/mecazicards_input henüz oluşmadı. Okuyucu takılı değilse, takınca otomatik oluşacak."
fi

# -------------------------------------------------------
# 4. python3 kontrolü - triggerhappy çakışmasını engellemek için
#    kullanılan grab_input.py bunu gerektiriyor (Volumio imajında
#    normalde zaten kurulu geliyor).
# -------------------------------------------------------
if ! command -v python3 &>/dev/null; then
  echo "python3 bulunamadı, kuruluyor..."
  apt-get update -qq 2>/dev/null || true
  apt-get install -y python3 2>/dev/null || echo "UYARI: python3 kurulamadı, triggerhappy çakışma engelleyici çalışmayacak."
fi

# -------------------------------------------------------
# 5. go-librespot açılışta Spotify'a giriş yapsın
#
#    Volumio, go-librespot'u "zeroconf" kipinde çalıştırıyor; o kipte cihaz
#    Spotify'a giriş yapmıyor, bir cast bekliyor. Bu yüzden her reboot'tan
#    sonra hiçbir şey çalmıyordu (Volumio'nun kendi arayüzünden bile),
#    ta ki telefondan bir kez cast edilene kadar.
#
#    Volumio config.yml'i her açılışta yeniden ürettiği için dosyayı elle
#    düzeltmek kalıcı olmuyor. Çözüm: düzeltmeyi go-librespot servisinin
#    ExecStartPre adımına bağlamak - Volumio ne zaman ezerse ezsin,
#    go-librespot dosyayı okumadan hemen önce ayar yerine konuyor.
# -------------------------------------------------------
LIBRESPOT_DROPIN_DIR="/etc/systemd/system/go-librespot-daemon.service.d"

# Düzeltici script'in yerini GÜVENİLİR biçimde bul.
# ÖNEMLİ: burada $(pwd) kullanmak hataya yol açtı - Volumio install.sh'ı bazen
# "/" dizininden çalıştırıyor, o zaman yol "//fix_librespot_config.py" oluyor
# ve ExecStartPre "dosya yok" (status=2) ile sessizce başarısız oluyordu.
# Bu yüzden önce eklentinin kurulu olduğu bilinen yola, sonra bu script'in
# kendi dizinine bakıyoruz - ve dosyanın gerçekten var olduğunu doğruluyoruz.
PLUGIN_DIR="/data/plugins/system_hardware/mecazicards_for_spotify"
FIX_SCRIPT="$PLUGIN_DIR/fix_librespot_config.py"

if [ ! -f "$FIX_SCRIPT" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/fix_librespot_config.py" ]; then
    FIX_SCRIPT="$SELF_DIR/fix_librespot_config.py"
  elif [ -n "$INSTALLING_DIR" ] && [ "$INSTALLING_DIR" != "/" ] && [ -f "$INSTALLING_DIR/fix_librespot_config.py" ]; then
    FIX_SCRIPT="$INSTALLING_DIR/fix_librespot_config.py"
  fi
fi

# Yedek yollardan biri kullanıldıysa (kurulum klasörü), o klasör ileride
# silinebilir - drop-in de yine var olmayan bir dosyayı gösterir hale gelir.
# Bu yüzden script'i kalıcı eklenti dizinine kopyalayıp oradan gösteriyoruz.
if [ -f "$FIX_SCRIPT" ] && [ "$FIX_SCRIPT" != "$PLUGIN_DIR/fix_librespot_config.py" ] && [ -d "$PLUGIN_DIR" ]; then
  if cp -f "$FIX_SCRIPT" "$PLUGIN_DIR/fix_librespot_config.py" 2>/dev/null; then
    FIX_SCRIPT="$PLUGIN_DIR/fix_librespot_config.py"
    echo "Düzeltici kalıcı dizine kopyalandı: $FIX_SCRIPT"
  fi
fi

if ! systemctl list-unit-files 2>/dev/null | grep -q '^go-librespot-daemon.service'; then
  echo "NOT: go-librespot-daemon servisi bulunamadı, açılış düzelticisi atlandı."
  echo "     (Volumio'nun Spotify eklentisi kurulu değilse bu normaldir.)"
elif [ ! -f "$FIX_SCRIPT" ]; then
  echo "UYARI: fix_librespot_config.py bulunamadı, açılış düzelticisi kurulmadı."
  echo "       Aranan yer: $PLUGIN_DIR"
else
  echo "go-librespot açılış düzelticisi kuruluyor: $FIX_SCRIPT"
  chmod +x "$FIX_SCRIPT" 2>/dev/null || true
  mkdir -p "$LIBRESPOT_DROPIN_DIR"
  cat > "$LIBRESPOT_DROPIN_DIR/mecazicards.conf" << DROPINEOF
# mecazicards_for_spotify tarafından eklendi.
# go-librespot başlamadan hemen önce credentials ayarını düzeltir, böylece
# cihaz açılışta Spotify'a kendi kendine giriş yapar (telefondan cast
# gerekmez). Script her koşulda 0 ile çıkar; servisi asla engellemez.
[Service]
ExecStartPre=-/usr/bin/python3 $FIX_SCRIPT
DROPINEOF
  systemctl daemon-reload 2>/dev/null || true

  # -----------------------------------------------------------------
  # Servis açılışta BAŞLATILIYOR mu?
  #
  # Uzun süre "reboot sonrası hiçbir şey çalmıyor" sorununu credentials
  # ayarında aradık. Asıl sebep bir katman aşağıdaydı: go-librespot-daemon
  # systemd'de 'disabled' durumdaydı, yani açılışta hiç başlamıyordu.
  # Başlamayan bir servis için credentials ayarının doğru olması hiçbir işe
  # yaramıyor. Telefondan cast etmek servisi ayağa kaldırdığı için sorun
  # "cast edince düzeliyor" gibi görünüyordu.
  #
  # Unit dosyasında [Install] WantedBy=multi-user.target var ve preset
  # 'enabled' - yani bu servis zaten açılışta başlamak üzere tasarlanmış.
  # Disabled olması anormallik; normale döndürüyoruz.
  #
  # ÖNEMLİ: önceki durumu kaydediyoruz ki uninstall.sh bulduğumuz hâle geri
  # döndürebilsin. Başka bir servisin ayarına dokunuyorsak, dokunduğumuzu
  # geri alabiliyor olmamız gerekir.
  # -----------------------------------------------------------------
  STATE_FILE="$LIBRESPOT_DROPIN_DIR/mecazicards-prior-enable-state"
  if [ ! -f "$STATE_FILE" ]; then
    # Sadece İLK kurulumda yaz - yoksa ikinci kurulumda kendi yaptığımız
    # 'enabled' durumunu "orijinal" sanıp geri dönüşü imkânsız hale getiririz.
    PRIOR_STATE="$(systemctl is-enabled go-librespot-daemon 2>/dev/null || true)"
    [ -z "$PRIOR_STATE" ] && PRIOR_STATE="bilinmiyor"
    echo "$PRIOR_STATE" > "$STATE_FILE"
    echo "go-librespot servisinin kurulum öncesi durumu kaydedildi: $PRIOR_STATE"
  fi

  CURRENT_ENABLE="$(systemctl is-enabled go-librespot-daemon 2>/dev/null || true)"
  if [ "$CURRENT_ENABLE" != "enabled" ]; then
    echo "go-librespot açılışta başlamıyordu ($CURRENT_ENABLE), etkinleştiriliyor..."
    if systemctl enable go-librespot-daemon 2>&1; then
      echo "Etkinleştirildi - artık her açılışta kendiliğinden başlayacak."
    else
      echo "UYARI: 'systemctl enable go-librespot-daemon' başarısız oldu."
      echo "       Reboot sonrası müzik çalmıyorsa elle çalıştırman gerekebilir."
    fi
  else
    echo "go-librespot zaten açılışta başlıyor, dokunulmadı."
  fi

  # Hemen uygula ki kullanıcı reboot beklemeden görsün
  /usr/bin/python3 "$FIX_SCRIPT" 2>&1 || true

  # -----------------------------------------------------------------
  # config.yml'in SAHİPLİĞİNİ ONAR.
  #
  # v3.9.x-v3.10.1 arasında bu script düzelticiyi root olarak çalıştırıyordu ve
  # düzeltici dosyayı geçici dosya + os.replace ile yeniden yaratıyordu. Sonuç:
  # config.yml'in sahibi root oluyordu ve Volumio (volumio kullanıcısı olarak
  # çalışıyor) kendi dosyasına yazamaz hale geliyordu:
  #
  #   EACCES: permission denied, open '/data/go-librespot/config.yml'
  #   Error initializing go-librespot daemon
  #
  # Belirtisi sinsiydi: müzik çalmaya devam ediyor ama Volumio go-librespot
  # yöneticisini başlatamadığı için ne çaldığını bilmiyor - arayüzde ve HDMI
  # ekranında şarkı bilgisi kayboluyor.
  #
  # Düzeltici artık sahipliği koruyor, ama daha önce bozulmuş kurulumları da
  # onarmamız gerekiyor: servisin User= değerine göre sahipliği geri veriyoruz.
  # -----------------------------------------------------------------
  LIBRESPOT_CONFIG="/data/go-librespot/config.yml"
  if [ -f "$LIBRESPOT_CONFIG" ]; then
    SVC_USER="$(systemctl show go-librespot-daemon -p User --value 2>/dev/null)"
    [ -z "$SVC_USER" ] && SVC_USER="volumio"
    CUR_OWNER="$(stat -c '%U' "$LIBRESPOT_CONFIG" 2>/dev/null)"
    if [ -n "$CUR_OWNER" ] && [ "$CUR_OWNER" != "$SVC_USER" ]; then
      echo "config.yml sahibi '$CUR_OWNER' görünüyor, '$SVC_USER' olmalı - onarılıyor..."
      if chown "$SVC_USER":"$SVC_USER" "$LIBRESPOT_CONFIG" 2>/dev/null; then
        echo "Sahiplik onarıldı: $SVC_USER"
      else
        echo "UYARI: sahiplik onarılamadı. Elle çalıştır:"
        echo "       sudo chown $SVC_USER:$SVC_USER $LIBRESPOT_CONFIG"
      fi
    fi
  fi

  systemctl restart go-librespot-daemon 2>/dev/null || true
  sleep 3

  # DOĞRULA: ExecStartPre gerçekten çalıştı mı? (Sessiz başarısızlık bize
  # günler kaybettirdi; bir daha sessizce geçmesin.)
  PRE_STATUS="$(systemctl show go-librespot-daemon -p ExecStartPre --value 2>/dev/null | grep -o 'status=[0-9]*' | head -1)"
  if [ "$PRE_STATUS" = "status=0" ] || [ -z "$PRE_STATUS" ]; then
    echo "go-librespot düzelticisi kuruldu ve çalıştı."
  else
    echo "UYARI: go-librespot düzelticisi kuruldu ama açılış adımı $PRE_STATUS ile döndü."
    echo "       Eklentinin kendi yedek mekanizması yine de devreye girecek."
  fi
fi

echo "mecazicards_for_spotify kurulumu tamamlandı."
echo "Eklentiyi Volumio arayüzünde 'Plugins' sayfasından etkinleştirmeyi unutma."

# Volumio Plugin Manager kurulumun bittiğini bu satırla anlıyor - SİLME.
echo "plugininstallend"
