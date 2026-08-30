# mecazicards for Spotify

**RFID kart okut → eşleştirilmiş Spotify listesi çalsın.** Volumio 3 eklentisi.

> Bu dosya **kullanım kılavuzudur**. Kurulum, sorun giderme ve "iki yıl sonra
> bunu nasıl yapmıştım" soruları buradan cevaplanır.
> Hangi sürümde ne değiştiğini merak edersen: `CHANGELOG.md`.

---

## İçindekiler

1. [Sistem nasıl çalışıyor](#sistem-nasıl-çalışıyor)
2. [Sıfırdan kurulum](#sıfırdan-kurulum)
3. [İlk ayarlar](#i̇lk-ayarlar)
4. [Yedekleme — en önemli bölüm](#yedekleme--en-önemli-bölüm)
5. [Eklenti sistemde neye dokunuyor](#eklenti-sistemde-neye-dokunuyor)
6. [Sorun giderme](#sorun-giderme)
7. [Dosya ve komut kılavuzu](#dosya-ve-komut-kılavuzu)
8. [Bilinen sınırlar](#bilinen-sınırlar)

---

## Sistem nasıl çalışıyor

Dört parça var:

| Parça | Görevi |
|---|---|
| **RFID okuyucu** (Sycreader `08ff:0009`) | USB'ye klavye gibi bağlanır, kart numarasını "yazar" |
| **Eklenti** (`index.js`) | Kart numarasını okur, eşleştirmeye bakar, çalma komutunu verir |
| **go-librespot** | Spotify'a bağlanan servis. Sesi bu çıkarır |
| **Volumio** | Ses yolu, arayüz, HDMI ekranı |

Kart okutulduğunda: okuyucu numarayı yazar → eklenti `/dev/mecazicards_hid`'den okur →
`config.json`'daki eşleştirmeden Spotify URI'sini bulur → çalma komutunu gönderir.

**Aynı kartı üst üste okutmak** "sonraki şarkı" demektir, baştan başlatmaz.

Kart galerisi ayrı bir web sayfasında: `http://mecaziradio.local:3500`
(Volumio ayarlarındaki eklenti sayfasından da bağlantı var.)

---

## Sıfırdan kurulum

### ⚠️ En kritik kural

> **`volumio plugin install` komutunu ASLA `sudo` ile çalıştırma.**

Volumio'nun arka plan servisi `root` değil, `volumio` kullanıcısı olarak çalışır.
`sudo` ile çağırırsan indirme adımı ile servisin kendisi farklı kullanıcı kimlikleriyle
çalışır ve kurulum "Permission denied" ile çöker. Bu gerçek cihazda yaşandı.

Dosya sahipliğini 2. adımda **bir kez** `sudo chown` ile düzelt, sonra kurulum
komutunun kendisinde sudo **kullanma**.

### Adımlar

**1.** Eklenti klasörünü cihaza kopyala (Samba ile de olur):

```
/mnt/INTERNAL/mecazicards_for_spotify
```

**2.** SSH ile bağlan ve sahiplik/izinleri düzelt — Samba ile kopyalanan
dosyalarda bu genelde bozuk kalır, bu adım **şart**:

```bash
sudo chown -R volumio:volumio /mnt/INTERNAL/mecazicards_for_spotify
chmod +x /mnt/INTERNAL/mecazicards_for_spotify/install.sh
chmod +x /mnt/INTERNAL/mecazicards_for_spotify/uninstall.sh
```

**3.** O klasörün **içindeyken** kur (sudo YOK):

```bash
cd /mnt/INTERNAL/mecazicards_for_spotify
volumio plugin install
```

Manuel olarak `/data/plugins/...` altına kopyalamana gerek yok — `volumio plugin install`
paketler, yükler, doğru kategori klasörüne kopyalar ve `install.sh`'ı çalıştırır.

**4.** Volumio arayüzünde **Plugins** sayfasına git, "mecazicards for Spotify"i bul,
**etkinleştir (enable)**.

**5.** Kurulumun düzgün bittiğini doğrula:

```bash
systemctl is-enabled go-librespot-daemon    # enabled olmalı
systemctl is-active  go-librespot-daemon    # active olmalı
ls -l /data/go-librespot/config.yml         # sahibi volumio:volumio olmalı
```

Üçü de doğruysa **reboot et** ve telefondan hiç cast etmeden bir kart okut.
Çalıyorsa kurulum tamam.

---

## İlk ayarlar

Galeri sayfasından (`http://mecaziradio.local:3500`):

**1. Spotify API kimlik bilgileri** — [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
adresinden ücretsiz bir uygulama aç, Client ID + Secret'ı gir. Bu **sadece isim ve
kapak gösterimi** ile Connect yetkilendirmesi için; çalmayı etkilemez.

**2. Redirect URI** — Spotify panelinde uygulamanın ayarlarına şu adresi ekle:

```
http://127.0.0.1:3500/spotify-connect/callback
```

> Nisan 2025'ten beri Spotify düz `http://` adresleri **sadece loopback** için kabul
> ediyor. `localhost` veya `192.168.x.x` **reddedilir**, `127.0.0.1` olmak zorunda.
> Cihazda tarayıcı olmadığı için akış "kodu kopyala-yapıştır" şeklinde ilerler.

**3. Çalma yöntemi** — "Sadece Volumio'nun kendi yöntemi (local)" önerilir.
Volumio o zaman ne çaldığını bilir, arayüzde ve HDMI ekranında şarkı bilgisi görünür.
Connect yöntemi komutu Spotify'ın bulutuna gönderdiği için Volumio devre dışı kalır.

**4. Hedef cihaz** — `mecaziradio` olarak sabitle. Sabitlemezsen komut evdeki başka
bir Spotify cihazına gidebilir (bir keresinde TV'den çalmıştı).

---

## Yedekleme — en önemli bölüm

**Kart eşleştirmeleri bu sistemin yerine konamaz tek parçası.** Kod her zaman yeniden
yazılır; 148 kartı tek tek okutup yeniden eşlemek saatler alır. Hepsi tek bir dosyada,
tek bir SD kartta duruyor — ve Raspberry Pi'lerde en sık görülen arıza SD kartın ölmesi.

### Arayüzden

Galeri sayfası → **Yedekle / Geri Yükle** → `Yedeği İndir`.
İnen JSON dosyasını **cihazın dışında** sakla (bilgisayar, bulut, e-posta).

Geri yüklerken iki yöntem var:

- **Birleştir** — yedektekiler eklenir/güncellenir, diğer kartların kalır.
- **Değiştir** — eşleştirmeler birebir yedektekiler olur.

Geri yüklemeden önce mevcut durum otomatik olarak `/tmp` altına yazılır ve yolu
ekranda gösterilir; yanlış bir geri yükleme geri alınabilir.

> Yedek dosyasına **kimlik bilgileri dâhil edilmez** (client secret, refresh token).
> Bu bilerek böyle: dosya buluta atılacak bir dosya. İkisi de kolay geri gelir —
> secret Spotify panelinden kopyalanır, token bir kez yetkilendirmeyle yenilenir.

### Komut satırından

```bash
cp /data/configuration/system_hardware/mecazicards_for_spotify/config.json \
   /mnt/INTERNAL/mecazicards-yedek-$(date +%F).json
```

---

## Eklenti sistemde neye dokunuyor

Bu bölüm ileride bir şey bozulduğunda nereye bakacağını söyler. Eklenti kendi
klasörünün **dışında** üç yere dokunuyor — üçü de `uninstall.sh` ile geri alınıyor:

| Ne | Nerede | Niçin |
|---|---|---|
| udev kuralı | `/etc/udev/rules.d/99-mecazicards.rules` | Okuyucuya sabit isim: `/dev/mecazicards_hid` ve `/dev/mecazicards_input` |
| systemd drop-in | `/etc/systemd/system/go-librespot-daemon.service.d/mecazicards.conf` | go-librespot başlamadan hemen önce `credentials` ayarını düzeltir |
| servis etkinleştirme | `systemctl enable go-librespot-daemon` | Servis açılışta başlasın diye. Kurulum öncesi durum kaydedilir, kaldırırken geri verilir |

**İkinci `/dev/input` symlink'i neden var?** Okuyucu USB'ye klavye gibi bağlandığı için
kernel iki arayüz açıyor. Volumio'nun **triggerhappy** servisi ikincisini dinliyor ve
Enter tuşunu play/pause sanıyor — kart okutunca şarkı 2-3 kez baştan sıçrıyordu.
Eklenti o düğümü `EVIOCGRAB` ile kilitliyor (`grab_input.py`). Sadece bu okuyucuyu
etkiler; air mouse dâhil başka hiçbir cihaz etkilenmez.

---

## Sorun giderme

Sorunların çoğu bu tabloda. **Önce tabloya bak, tahmin etme.**

| Belirti | Muhtemel sebep | Kontrol / çözüm |
|---|---|---|
| **Reboot sonrası hiçbir şey çalmıyor**, telefondan bir kez cast edince düzeliyor | go-librespot açılışta başlamıyor veya Spotify'a giriş yapmıyor | `systemctl is-enabled go-librespot-daemon` → `enabled` değilse `sudo systemctl enable go-librespot-daemon` |
| **Müzik çalıyor ama Volumio arayüzünde/HDMI'da şarkı bilgisi yok** | `config.yml` sahibi root olmuş, Volumio yazamıyor | `sudo chown volumio:volumio /data/go-librespot/config.yml` sonra `sudo systemctl restart volumio` |
| **Cihaz Spotify Connect listesinde görünmüyor** | Servis ölü | `systemctl is-active go-librespot-daemon`; ölüyse `sudo systemctl start go-librespot-daemon` ve log'a bak |
| **Kartı görüyor ama çalmıyor** | Liste silinmiş veya erişilemiyor | Galeride kartın ismi boşsa liste ölmüş demektir; yeni bir listeye eşle |
| **Playlist ismi/kapağı gelmiyor** | Editoryal liste (`37i9dQZ...`) veya kişiselleştirilmiş liste (Blend, Daily Mix, daylist) | Aşağıdaki "Bilinen sınırlar"a bak |
| **Arayüz yeni ama davranış eski** | Volumio eski `index.js`'i bellekte tutuyor | `sudo systemctl restart volumio` |
| **Tarayıcıda eski görsel/logo** | Tarayıcı önbelleği | Sayfayı sert yenile (Ctrl+Shift+R) veya son bir saatin önbelleğini sil |
| **Aynı kartta şarkı 2-3 kez baştan sıçrıyor** | triggerhappy çakışması | Çözülmüş olmalı; `/dev/mecazicards_input` var mı diye bak |
| **Kurulum "Permission denied" ile çöküyor** | `sudo volumio plugin install` çalıştırılmış | Yukarıdaki kurulum adımlarını sudo'suz tekrarla |

### İşe yarayan teşhis komutları

```bash
# Servis durumu + açılış düzelticisi tek bakışta
systemctl status go-librespot-daemon --no-pager -l | grep -E "Active:|ExecStartPre|Drop-In"

# go-librespot açılışta ne yaptı
sudo journalctl -u go-librespot-daemon -b --no-pager | grep -E "librespot-fix|authenticated|zeroconf server"

# Volumio tarafında Spotify hataları
sudo journalctl -u volumio -b --no-pager | grep -iE "spop|librespot"

# Eklentinin kendi log'u
sudo journalctl -u volumio -f | grep mecazicards

# go-librespot şu an ne çalıyor
curl -s http://127.0.0.1:9879/status

# Volumio ne çaldığını sanıyor
volumio status
```

> **Boş çıktı her zaman "yok" demek değildir.** `systemctl status | grep ExecStartPre`
> boş dönüyorsa bu "drop-in kurulmamış" demek olmayabilir — servis o boot'ta hiç
> çalışmadıysa systemd o satırı zaten basmaz. Önce `Active:` satırına bak.

---

## Dosya ve komut kılavuzu

| Ne | Nerede |
|---|---|
| Eklenti kodu | `/data/plugins/system_hardware/mecazicards_for_spotify/` |
| **Kart eşleştirmeleri (yedekle!)** | `/data/configuration/system_hardware/mecazicards_for_spotify/config.json` |
| Ayarların otomatik yedeği | `.../kullanici-ayarlari-yedegi.json` — güncelleme sonrası buradan geri gelir |
| Elle yüklenen kapaklar | `.../card-images/` |
| go-librespot ayarı | `/data/go-librespot/config.yml` — sahibi `volumio:volumio` olmalı |
| go-librespot kimliği | `/data/go-librespot/state.json` — **gizli**, paylaşma |
| Kart galerisi | `http://mecaziradio.local:3500` |
| go-librespot API | `http://127.0.0.1:9879` |

**Kaldırma:** Volumio arayüzü → **Plugins** → mecazicards for Spotify → kaldır.
`uninstall.sh` udev kuralını, systemd drop-in'ini ve servis etkinleştirmesini geri alır.
Kart eşleştirmeleri `/data/configuration/...` altında **kalır** — yeniden kurunca geri gelir.
Yine de kaldırmadan önce bir yedek indir.

**Yeniden kurma:** yukarıdaki [Sıfırdan kurulum](#sıfırdan-kurulum) adımlarını tekrarla.

---

## Bilinen sınırlar

**Editoryal listeler (`37i9dQZF1DX...`)** — Spotify, Kasım 2024'te bu listeleri Web
API'sinden üçüncü parti uygulamalara kapattı; `/v1/playlists/{id}` kullanıcı token'ıyla
bile 404 döner. İsim ve kapağı **oEmbed** üzerinden alıyoruz (kimlik gerektirmez).
Çalmayı etkilemez.

**Kişiselleştirilmiş listeler (daylist, Daily Mix, Blend, Discover Weekly)** — bunların
ismi ve kapağı **hiçbir API yolundan alınamıyor.** Cihazda dört yolu da ölçtük:

| Yol | Sonuç |
|---|---|
| `/v1/playlists/{id}` | 404 — Spotify'ın Kasım 2024 kısıtlaması |
| oEmbed | 404 — liste herkese açık değil |
| `/v1/me/playlists` | 200, 70 liste döndü — kişisel listeler içinde yok |
| `/v1/views/made-for-x` | **401** — yalnızca Spotify'ın kendi uygulamasına açık |

Son satır belirleyici: 401, 404 değil. "Böyle bir şey yok" değil, "senin token'ın buraya
giremez". Spotify uygulamasında görüyorsun çünkü kendi istemcisi farklı yetkilerle
konuşuyor; üçüncü parti geliştirici anahtarıyla o kapı açılmıyor.

**Çözüm: karta elle isim ve kapak ver.** Galeride karta tıkla → "Kartın görünüşü".
Elle verdiğin isim/kapak Spotify'dan gelene her zaman baskındır ve Spotify yarın bu
uçları büsbütün kapatsa da çalışmaya devam eder.

> Bu kartlar aslında en iyi kartlar: içerikleri sürekli değişir, yani aynı kart her
> gün farklı müzik çalar. daylist özellikle — sabah başka, akşam başka. Zaten sabit
> bir kapak da yanıltıcı olurdu; "daylist" yazan sade bir kart daha doğru.

Kapak görselleri `card-images/` altına, config'in yanına kaydedilir — eklenti
güncellemesi onları silmez.

**Silinmiş listeler** — Spotify zaman zaman liste emekliye ayırıyor. Belirtisi: galeride
hem isim hem kapak boş. Çözüm veri tarafında: o kartı yaşayan bir listeye yeniden eşle.

**Volumio güncellemeleri** — büyük bir Volumio güncellemesi systemd drop-in'ini veya
servis etkinleştirmesini sıfırlayabilir. Güncelleme sonrası müzik çalmıyorsa yukarıdaki
tablonun ilk satırına bak, gerekirse eklentiyi yeniden kur.
