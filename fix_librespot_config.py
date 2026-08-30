#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
go-librespot'un Spotify oturumunu açılışta otomatik kurmasını sağlar.

SORUN
-----
Volumio, go-librespot'u `credentials.type: zeroconf` kipinde çalıştırıyor.
Bu kipte cihaz ağda kendini duyuruyor ama Spotify'a GİRİŞ YAPMIYOR - giriş,
ancak telefondan/PC'den cast edildiğinde gerçekleşiyor. Cihaz her yeniden
başladığında oturum sıfırlanıyor ve hiçbir şey çalmıyor (Volumio'nun kendi
arayüzünden bile), ta ki bir kez cast edilene kadar.

ÇÖZÜM
-----
go-librespot bir kez giriş yaptığında kimliği `state.json`'a yazabiliyor
(zeroconf.persist_credentials). Saklı kimlik varken `credentials.type`
`interactive` yapılırsa, açılışta o kimlikle kendi kendine giriş yapıyor -
tarayıcı sormuyor, zeroconf ilanı da açık kalıyor (yani telefondan cast
yeteneği kaybolmuyor). Bunu cihazda doğruladık.

NEDEN BU SCRIPT
---------------
Volumio, `config.yml`'i kendi ayarlarından her açılışta yeniden üretiyor ve
elle yaptığımız değişikliği siliyor. Bu script, go-librespot servisinin
ExecStartPre adımı olarak çalışıyor: yani Volumio dosyayı ne zaman ezerse
ezsin, go-librespot dosyayı OKUMADAN hemen önce ayar geri konmuş oluyor.
Volumio ile yarışmıyoruz, sadece son sözü söylüyoruz.

DAVRANIŞ (kendi kendini onaran)
-------------------------------
* state.json'da saklı kimlik VARSA   -> credentials.type = interactive
    (açılışta otomatik giriş)
* state.json'da saklı kimlik YOKSA   -> credentials.type = zeroconf +
    zeroconf.persist_credentials = true
    (bir kez cast et, kimlik yazılsın; sonraki açılışta üstteki dala geçer)

Böylece Spotify'da "her yerde oturumu kapat" dersen sistem kilitlenmiyor:
kimlik geçersiz kalınca bir cast ile kendini toparlıyor.

GÜVENLİK
--------
Bu script go-librespot'un ÖNÜNDE çalıştığı için, hata verirse servis hiç
başlamaz. Bu yüzden her durumda 0 ile çıkıyor - hiçbir hata go-librespot'u
engellemiyor.
"""

import base64
import json
import os
import stat
import sys

CONFIG = '/data/go-librespot/config.yml'
STATE = '/data/go-librespot/state.json'


def log(msg):
    sys.stderr.write('[mecazicards/librespot-fix] %s\n' % msg)


def stored_credentials_exist():
    """state.json'da YAPISAL OLARAK GEÇERLİ bir kimlik var mı?

    Sadece "alan dolu mu" diye bakmak yetmiyor. `interactive` kipine geçip de
    kimlik bozuksa go-librespot giriş yapamaz; kötü ihtimalde servis hiç ayağa
    kalkmaz ve cihaz Spotify Connect listesinden tamamen kaybolur. Bir düzeltici
    hiçbir koşulda çalışan bir servisi bozacak duruma sokmamalı - o yüzden
    şüphedeysek güvenli tarafa, yani zeroconf'a düşüyoruz: o kipte en kötü
    ihtimalle "telefondan bir kez cast et" durumuna döneriz, sessizce ölmeyiz.

    Kimliğin Spotify tarafında hâlâ geçerli olup olmadığını buradan anlayamayız
    (bunu ancak sunucu söyler), ama yapısal bozuklukları yakalayabiliriz.
    """
    try:
        with open(STATE, 'r') as f:
            data = json.load(f)
    except Exception:
        return False

    if not isinstance(data, dict):
        return False

    creds = data.get('credentials')
    if not isinstance(creds, dict):
        return False

    username = creds.get('username')
    blob = creds.get('data')
    if not isinstance(username, str) or not username.strip():
        return False
    if not isinstance(blob, str) or not blob.strip():
        return False

    raw = decode_blob(blob)
    if raw is None:
        log('saklı kimlik base64 olarak çözülemedi, bozuk sayılıyor')
        return False
    if len(raw) < 32:
        log('saklı kimlik şüpheli derecede kısa (%d bayt), bozuk sayılıyor' % len(raw))
        return False

    return True


def decode_blob(blob):
    """Kimlik blob'unu çözmeye çalışır; olmazsa None döner.

    Bilerek TOLERANSLI: go-librespot'un blob'u hangi base64 lehçesiyle yazdığını
    varsaymak istemiyoruz. Kontrolün amacı gerçekten bozuk bir kimliği yakalamak;
    sağlam bir kimliği lehçe farkı yüzünden "bozuk" ilan edersek çalışan kurulumu
    kendi elimizle zeroconf'a düşürmüş oluruz. Bu yüzden standart ve URL-güvenli
    alfabeyi, eksik dolgu (padding) ihtimaliyle birlikte deniyoruz.
    """
    text = blob.strip()
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        for pad in range(4):
            try:
                out = decoder(text + '=' * pad)
                if out:
                    return out
            except Exception:
                continue
    return None


def desired_block(has_creds):
    if has_creds:
        return ['credentials:\n', '  type: interactive\n']
    return [
        'credentials:\n',
        '  type: zeroconf\n',
        '  zeroconf:\n',
        '    persist_credentials: true\n',
    ]


def rewrite(lines, has_creds):
    """`credentials:` bloğunu bulup istediğimizle değiştirir.

    YAML kütüphanesine bağımlı olmamak için satır bazlı çalışıyoruz - Volumio
    imajında PyYAML kurulu olmayabilir ve bu script'in her koşulda çalışması
    gerekiyor. Blok, `credentials:` satırından başlayıp girintili satırlar
    bitene kadar sürüyor.
    """
    out = []
    i = 0
    found = False
    while i < len(lines):
        line = lines[i]
        if line.split('#')[0].strip() == 'credentials:':
            found = True
            i += 1
            # Bloğa ait girintili satırları atla
            while i < len(lines) and (lines[i].startswith((' ', '\t')) or not lines[i].strip()):
                if lines[i].strip() and not lines[i].startswith((' ', '\t')):
                    break
                if not lines[i].strip():
                    # Boş satır: blok bitmiş olabilir, sonrasına bak
                    j = i + 1
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and not lines[j].startswith((' ', '\t')):
                        break
                i += 1
            out.extend(desired_block(has_creds))
            continue
        out.append(line)
        i += 1

    if not found:
        if out and not out[-1].endswith('\n'):
            out[-1] += '\n'
        out.extend(desired_block(has_creds))
    return out


def main():
    if not os.path.exists(CONFIG):
        log('config.yml yok, atlanıyor: %s' % CONFIG)
        return

    has_creds = stored_credentials_exist()

    with open(CONFIG, 'r') as f:
        lines = f.readlines()

    new_lines = rewrite(lines, has_creds)

    if new_lines == lines:
        log('ayar zaten doğru (saklı kimlik: %s), dokunulmadı' % ('var' if has_creds else 'yok'))
        return

    write_preserving_ownership(CONFIG, new_lines)
    log('credentials.type -> %s (saklı kimlik: %s)'
        % ('interactive' if has_creds else 'zeroconf+persist', 'var' if has_creds else 'yok'))


def write_preserving_ownership(target, new_lines):
    """Dosyayı SAHİPLİĞİNİ VE İZİNLERİNİ KORUYARAK yeniden yazar.

    NEDEN: bu script iki farklı kullanıcı olarak çalışıyor - systemd
    ExecStartPre adımında `volumio`, install.sh içinde ise `root`. Geçici dosya
    yazıp os.replace ile değiştirmek dosyayı YENİDEN YARATIYOR; root olarak
    çalıştığında yeni dosyanın sahibi root oluyor ve Volumio (volumio kullanıcısı)
    kendi config dosyasına bir daha yazamıyor:

        EACCES: permission denied, open '/data/go-librespot/config.yml'
        Error initializing go-librespot daemon

    Bunun sonucu sinsiydi: müzik çalmaya devam ediyordu (go-librespot ayakta),
    ama Volumio go-librespot yöneticisini başlatamadığı için durum dinleyicisini
    bağlayamıyordu - arayüzde ve HDMI ekranında şarkı bilgisi kayboluyordu.

    Bu yüzden: önce orijinalin sahibini/iznini okuyoruz, geçici dosyaya
    uyguluyoruz, ondan sonra yerine koyuyoruz. chown yalnızca root'ken gerekli
    ve mümkün; root değilken zaten aynı kullanıcı yazdığı için sahiplik değişmiyor.
    """
    st = os.stat(target)
    tmp = target + '.mecazicards.tmp'

    try:
        with open(tmp, 'w') as f:
            f.writelines(new_lines)

        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except (OSError, AttributeError) as err:
            # root değilsek chown başarısız olabilir - ama o durumda dosyayı
            # zaten orijinal sahibiyle aynı kullanıcı yazıyor demektir.
            if os.geteuid() == 0:
                raise
            cur = os.stat(tmp)
            if (cur.st_uid, cur.st_gid) != (st.st_uid, st.st_gid):
                raise RuntimeError('sahiplik korunamadı: %s' % err)

        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.replace(tmp, target)
    except Exception:
        # Yarım kalmış geçici dosya bırakma.
        try:
            if os.path.exists(tmp):
                os.unlink(tmp)
        except Exception:
            pass
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        # Asla go-librespot'un başlamasını engelleme.
        log('beklenmedik hata (yok sayılıyor): %s' % err)
    sys.exit(0)
