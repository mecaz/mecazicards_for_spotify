#!/bin/bash
# mecazicards: Mac'ten tek tıkla kurulum/güncelleme.
# Zip'i Mac'te aç, bu dosyaya çift tıkla. Klasörü SSH ile Pi'ye gönderip
# orada kur.sh'ı çalıştırır. Başka bir cihaz için: MECAZICARDS_PI=volumio@192.168.1.50
cd "$(dirname "$0")" || exit 1
PI="${MECAZICARDS_PI:-volumio@mecaziradio.local}"
SOKET="/tmp/mecazicards-ssh-$$"
SSH="ssh -o ControlMaster=auto -o ControlPath=$SOKET -o ControlPersist=180"
bitir() { $SSH -O exit "$PI" 2>/dev/null; echo; read -r -p "Pencereyi kapatmak için Enter'a bas." _; }
trap bitir EXIT

echo "mecazicards -> $PI"
echo "(volumio parolası istenecek; bir kez girmen yeter)"
$SSH "$PI" 'rm -rf ~/.mecazicards-gelen && mkdir -p ~/.mecazicards-gelen' \
  || { echo "Pi'ye bağlanılamadı. Açık mı, adı mecaziradio.local mi?"; exit 1; }
rsync -a --delete --exclude node_modules --exclude .git --exclude .DS_Store --exclude '._*' -e "$SSH" ./ "$PI:.mecazicards-gelen/" \
  || { echo "Dosyalar gönderilemedi."; exit 1; }
$SSH -t "$PI" 'bash ~/.mecazicards-gelen/kur.sh ~/.mecazicards-gelen'
