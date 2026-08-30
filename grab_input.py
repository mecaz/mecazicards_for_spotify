#!/usr/bin/env python3
"""
mecazicards_for_spotify - evdev grab yardimcisi

RFID okuyucu USB'ye "klavye" olarak bagliyor. Kernel bu yuzden AYNI fiziksel
cihaz icin iki ayri arayuz olusturuyor:
  - /dev/hidraw*  -> eklentinin (index.js) dogrudan okudugu ham HID raporlari
  - /dev/input/eventN -> standart klavye olay akisi; Volumio'nun triggerhappy
    (thd) servisi de BUNU dinliyor ve varsayilan olarak "Enter" tusunu
    play/pause'a baglamis oluyor.

Kart okutunca gonderilen rakamlar + Enter, triggerhappy tarafindan da
"play/pause tusuna basildi" olarak algilaniyor ve bizim komutumuzla yarisiyor
(sarkinin bas tarafa sicrayip durmasi, "3 kere basa sarmasi" gibi belirtiler
buradan geliyor).

Cozum: bu script sadece /dev/input/eventN dugumunu ac ve EVIOCGRAB ioctl'i ile
"kilitle" (exclusive grab). thd bu ioctl'i hic cagirmadigi icin, biz
kilitledigimiz an itibariyle bu cihazdan gelen olaylari BASKA HICBIR process
(triggerhappy dahil) goremez olur. Eklentinin kendisi olaylari zaten
/dev/hidraw uzerinden okudugu icin bu grab'dan etkilenmez.

Kullanim: python3 grab_input.py /dev/mecazicards_input
"""

import sys
import os
import fcntl
import time

# EVIOCGRAB = _IOW('E', 0x90, int) -- Linux'ta tum mimarilerde (x86/arm/arm64)
# ayni sabit deger (int'in boyutu 4 byte oldugu icin degismiyor).
EVIOCGRAB = 0x40044590


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Kullanim: grab_input.py <event-device-yolu>\n")
        sys.exit(2)

    device_path = sys.argv[1]

    # Cihaz henuz hazir olmayabilir (udev/USB gecikmesi) - kisa bir sure dene.
    fd = None
    for _ in range(20):
        try:
            fd = os.open(device_path, os.O_RDONLY)
            break
        except OSError:
            time.sleep(1)

    if fd is None:
        sys.stderr.write("HATA: %s acilamadi.\n" % device_path)
        sys.exit(1)

    try:
        fcntl.ioctl(fd, EVIOCGRAB, 1)
    except OSError as e:
        sys.stderr.write("HATA: EVIOCGRAB basarisiz: %s\n" % e)
        os.close(fd)
        sys.exit(1)

    sys.stdout.write("grabbed:%s\n" % device_path)
    sys.stdout.flush()

    # fd'yi acik tutup bekle; bu process SIGTERM ile (plugin durunca) olene
    # kadar grab aktif kalir. Kernel process olunce fd'yi otomatik kapatir ve
    # grab kendiliginden serbest kalir, ekstra temizlik gerekmez.
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            fcntl.ioctl(fd, EVIOCGRAB, 0)
        except OSError:
            pass
        os.close(fd)


if __name__ == '__main__':
    main()
