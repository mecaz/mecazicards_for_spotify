# mecazicards for Spotify — Sürüm Geçmişi

Bu dosya, her sürümde neyin neden değiştiğini anlatır. Günlük kullanım ve
kurulum için `README.md`'ye bak — bu dosya arşiv niteliğindedir.

## v2.0.1 düzeltmesi: "TypeError: Cannot read properties of undefined (reading 'name')"

Kurulum "Copying plugin to location" adımından sonra bu hatayla düşüyordu çünkü `package.json` içinde `plugin_type: "accessory"` yazıyordum — bu, Volumio 2 döneminden kalma bir kategori adıydı. Volumio 3 sadece şu 5 kategoriyi tanıyor: `audio_interface`, `music_service`, `system_hardware`, `system_controller`, `user_interface`. Volumio, tanımadığı "accessory" kategorisini bir listede ararken `undefined` dönüyor ve `.name` okumaya çalışınca çöküyor.

Düzeltme: `plugin_type` artık `system_hardware` (gerçek bir Volumio 3 GPIO eklentisinden doğrulayarak teyit ettim), ve buna bağlı olarak eklenti klasör yolu da `/data/plugins/system_hardware/mecazicards_for_spotify` oldu.

## v2.1.0 düzeltmesi: aynı kartı tekrar okutunca şarkının 2-3 kez baştan sıçraması (triggerhappy çakışması)

Bunu sen teşhis ettin, doğruydu: RFID okuyucu USB'ye "klavye" gibi bağlanıyor. Kernel bu yüzden aynı fiziksel cihaz için iki ayrı arayüz oluşturuyor - `/dev/hidraw*` (eklentinin okuduğu ham veri) ve `/dev/input/eventN` (standart klavye olay akışı). Volumio'nun **triggerhappy** (`thd`) servisi ikinciyi dinliyor ve varsayılan olarak Enter tuşunu play/pause'a bağlamış durumda. Kart okutunca gönderilen "rakamlar + Enter", triggerhappy tarafından da "birisi play/pause tuşuna bastı" sanılıyor ve bizim `replaceAndPlay`/`volumioNext` komutumuzla aynı anda yarışıyor - şarkının birkaç kez baştan sıçraması buradan geliyordu. Aynı sebeple air mouse'unun orta tuşunu (o da muhtemelen aynı "Enter" olayını tetikliyor) play/pause için kullanamıyordun.

Düzeltme: eklenti artık ikinci bir udev symlink'i (`/dev/mecazicards_input`) üzerinden, sadece bu RFID okuyucuya özel `/dev/input/eventN` düğümünü **EVIOCGRAB** ile exclusive kilitliyor (bkz. `grab_input.py`). triggerhappy bu ioctl'i hiç kullanmadığı için (kaynak kodundan doğruladım), kilit bizde kaldığı sürece bu cihazdan gelen olayları bir daha hiç görmüyor. Bu SADECE bu RFID okuyucuyu etkiliyor - air mouse dahil başka hiçbir klavye/uzaktan kumanda etkilenmiyor, yani air mouse'un orta tuşunu artık güvenle play/pause'a bağlayabilirsin.

## v2.2.0 — arayüz iyileştirmeleri

Senin verdiğin fikirlerden ikisini ekledim:

- **Tanınmayan kart otomatik dolduruluyor**: Eşleşmesi olmayan bir kart okutulduğunda, "Eşleştirme Ekle / Güncelle" bölümündeki Kart ID alanı otomatik olarak o kartın seri numarasıyla doluyor - elle yazmana gerek yok.
- **Kart okuyucu artık dropdown'dan seçiliyor**: "Kart Okuyucu Cihazı" ve onun klavye arayüzü artık sabit yazı yerine, o an sisteme takılı olan cihazları (isim + vendor:product ile) listeleyen birer açılır menü. Başka bir okuyucu taksan, listeden seçebilirsin - `/dev/mecazicards_hid` sabit seçeneği hâlâ önerilen/varsayılan.

Henüz eklemediğim (senden onay bekleyen): **playlist/sanatçı isimlerini göstermek**. Bunun için Spotify Web API'den okuma yapmak gerekiyor, bu da ücretsiz bir Spotify Developer uygulaması (client ID + secret) açman anlamına geliyor - playback'i etkilemez, sadece isim gösterimi için. İstersen bunu konuşalım. Kart/playlist görselleri konusunu senin dediğin gibi ileri bir aşamaya bıraktım.

## v2.3.0 — Spotify playlist/sanatçı isimleri

Yeni "Spotify API Kimlik Bilgileri" bölümüne (ayarlar sayfasında) ücretsiz bir Spotify Developer uygulamasının Client ID + Client Secret'ını girince, "Kayıtlı Eşleştirmeler" listesinde artık ham `spotify:playlist:...` yerine gerçek playlist/sanatçı ismi görünüyor (URI de yanında küçük yazıyla kalıyor). Yeni eklenen bir kart otomatik olarak arka planda ismini çekiyor; "İsimleri Yenile" bölümündeki düğmeyle istediğin zaman hepsini toplu yeniden çekebilirsin.

Bu **sadece görüntüleme** için — playback hâlâ tamamen Volumio'nun kendi Spotify eklentisi üzerinden, hiç dokunmadım. Client ID/Secret'ı boş bırakırsan (veya hiç girmezsen) eklenti eskisi gibi ham URI'leri göstermeye devam eder, hiçbir şey bozulmaz.

Not: Bu isim çekme akışını (client-credentials + `/v1/playlists/{id}`, `/v1/artists/{id}` gibi uçlar) benim çalıştığım ortamdan canlı test edemedim çünkü buradan Spotify'ın sunucularına ağ erişimim yok - resmi, uzun süredir değişmeyen Spotify Web API sözleşmesine dayanarak yazdım, kodun kendisini (hata yönetimi, önbellekleme, arayüz entegrasyonu) sahte kimlik bilgileriyle uçtan uca test ettim. Cihazında ilk denediğinde bir sorun çıkarsa (özellikle "Kaydedildi" sonrası gelen hata mesajını) bana ilet, hızlıca düzeltirim.

## v3.0.0 — Spotify Connect ile çalma (kartlar artık gerçekten sesli çalıyor)

### Neden gerekti

Kart okutunca çalma listesi kuyruğa doluyordu ama hiç ses gelmiyordu — bunu senin cihazında adım adım teşhis ettik: eklentimizin kendi mantığı (log'lar) tamamen doğruydu, `/etc/hosts` temizdi, Spotify eklentisini güncel sürüme (4.4.2) kaldırıp yeniden kursak da değişmedi. Son olarak Volumio'nun **kendi arayüzünden**, bizim eklentimize hiç dokunmadan, elle bir playlist'e "play" dedik — yine sessizdi. Bu da sorunun bizim kodumuzda değil, Volumio'nun Spotify/go-librespot entegrasyonunda olduğunu kanıtladı. Volumio'nun resmi beta test forumunda ekibin kendisi de bunu doğruluyor: "We noticed a big degradation in spotify and librespot performance lately, probably due to some changes on Spotify level." Buna karşılık telefon/PC'den Spotify Connect ile cihazı seçip çaldırmak (cast) her zaman sorunsuz çalışıyor.

### Çözüm

Eklenti artık, kart okutulduğunda Volumio'nun kendi (bozuk) yerel çalma mekanizması yerine **Spotify'ın resmi Web API'sindeki Connect kontrol uçlarını** kullanıyor — yani tam olarak telefondan "cihaz seç" yapıp cast eder gibi, ama otomatik olarak. Bunun için bir kere, tarayıcıdan Spotify hesabınla yetki vermen gerekiyor (aşağıya bak). Yetkilendirme yapılmazsa eklenti otomatik olarak eski (yerel) yönteme döner — hiçbir şey kırılmaz, sadece muhtemelen yine sessiz kalır.

### Kurulum sonrası ekstra adım: yetkilendirme (3 adım, bir kerelik)

Yetkilendirme adımlarının tamamı **kart galerisi sayfasında** (`http://<cihaz-ip>:3500/`) adım adım anlatılıyor, orayı takip etmen yeterli. Özet:

1. **Redirect URI'yi Spotify Dashboard'a ekle.** [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) → uygulaman → Edit Settings → **Redirect URIs** kısmına birebir şunu ekle:
   ```
   http://127.0.0.1:3500/spotify-connect/callback
   ```
2. Galeri sayfasındaki **"Spotify'da Yetkilendir"** butonuna bas, Spotify hesabınla giriş yapıp izin ver.
3. İzin verdikten sonra tarayıcı `127.0.0.1` adresine gitmeye çalışıp **"bağlantı reddedildi"** hatası verecek — **bu normal ve beklenen bir durum**. O sayfanın **adres çubuğundaki adresin tamamını** kopyalayıp galeri sayfasındaki 3. adımdaki kutuya yapıştır ve "Yetkilendirmeyi Tamamla"ya bas.

Sonra bir kart okut — artık gerçekten ses gelmesi lazım.

#### Neden 127.0.0.1, neden bu kopyala-yapıştır adımı?

Spotify, 9 Nisan 2025'ten beri redirect URI olarak düz `http://` adreslerini **sadece loopback (`127.0.0.1`)** için kabul ediyor; `localhost` ve LAN IP'si (`192.168.x.x`) artık geçersiz — bunları eklersen "redirect_uri: Not matching configuration" ya da "INVALID_CLIENT: Insecure redirect URI" hatası alırsın. Ama `127.0.0.1`, telefonundan/bilgisayarından bakınca Raspberry Pi'yi değil kendi cihazını gösterdiği için tarayıcı o adrese ulaşamıyor. Bu yüzden kodu tarayıcının adres çubuğundan elle taşıyoruz — kablosuz/headless cihazlarda standart olan yöntem bu.

**Alternatif (tamamen otomatik, SSH bilenler için):** Bilgisayarından `ssh -L 3500:localhost:3500 volumio@<cihaz-ip>` ile tünel açıp yetkilendirmeyi `http://127.0.0.1:3500/spotify-connect/authorize` üzerinden başlatırsan, geri dönüş adresi tünel sayesinde gerçekten cihaza ulaşır ve kopyala-yapıştır adımına hiç gerek kalmaz.

**İyi haber:** Adres artık cihazın IP'sine bağlı olmadığı için, DHCP ile IP değişse bile Dashboard'daki kaydı bir daha güncellemen gerekmiyor. Yetkilendirme de bir kerelik — `refresh_token` kalıcı olarak saklanıyor.

### Kart galerisi

Volumio ayarlar sayfasındaki "Kart Galerisi ve Spotify Connect" bölümünde **"Kart Galerisini Aç"** butonuna basınca, Volumio'nun basit form arayüzünün ötesinde, senin hazırladığın fiziksel kartlara benzer görsel bir galeri açılıyor (kapak resmi + Raspberry Pi/Spotify şeritli tasarım). Bu, eklentinin kendi içinde çalışan küçük bir web sunucusu (`:3500` portu) üzerinden geliyor — resmi Volumio eklentilerinin (RTL-SDR/FM-DAB Radyo gibi) zengin arayüz için kullandığı aynı yöntem (`openUrl` tipi buton + bağımsız port).

## v3.1.0 — dikey kart tasarımı ve logolar

Kart galerisindeki kartlar artık gerçek bir RFID kartı gibi **dikey** (ID-1 oranı, 54 x 85.6 mm). Yerleşim:

```
┌─────────────────┐
│ volumio    ((•  │   üstte Volumio logosu, sağ üstte RFID sembolü
│ ┌─────────────┐ │
│ │             │ │
│ │  albüm/liste│ │   ortada KARE kapak görseli (hiç kırpılmadan)
│ │   kapağı    │ │
│ └─────────────┘ │
│ Playlist Adı    │
│ ÇALMA LİSTESİ   │   isim + tür + kart numarası
│         00027756│
│ 🍓          ⏺   │   alt köşeler: Raspberry Pi ve Spotify
└─────────────────┘
```

Kapak görselleri artık kare bir alana yerleştiği için **tamamı görünüyor** (eski yatay tasarımda kare görselin altı üstü kırpılıyordu). Kapağın bulanık bir kopyası da kartın arka planına yayılıyor, böylece her kart kendi renk paletini alıyor.

## v3.13.1 — güncelleme artık HİÇBİR ayarı silmiyor

v3.13.0 kart eşleştirmelerini kurtarıyordu ama sorun çok daha genişmiş. Paketteki `config.json` şablonu **boş** ve Volumio güncellemede canlı config'i onunla eziyor. Yani her güncelleme şunları siliyordu:

| Silinen | Kullanıcıya yansıması |
|---|---|
| `spotify_client_id` / `spotify_client_secret` | API bilgilerini yeniden gir |
| `spotify_refresh_token` | **Hesabı yeniden bağla** |
| `resolved_names` | İsimler gitti, ham URI kaldı |
| `play_stats` | Çalma istatistiği sıfırlandı |
| `custom_info` | Elle verilen isim/kapaklar gitti |
| `playback_mode`, `gallery_sort`, hedef cihaz | Varsayılana döndü |

Kullanıcının her güncellemeden sonra "API'yi girip hesabı yeniden bağlaması" bundandı — kodda isim çekme hatası yoktu, ayarlar siliniyordu.

Artık korunan şey kartlar değil, **kullanıcıya ait tüm ayarlar**. Yedek config'in yanında (`kullanici-ayarlari-yedegi.json`, izin 600) duruyor; paketin içinde olmadığı için güncelleme ezemiyor.

Geri yükleme mantığı iki kademeli:

- **Kartlar silinmişse** config baştan yazılmış demektir; varsayılana dönmüş ayarlar da (`playback_mode`, `gallery_sort` gibi) geri alınıyor.
- **Aksi hâlde** yalnızca BOŞ olan anahtarlar dolduruluyor — dolu bir değer asla ezilmiyor, kullanıcının verisi her zaman üstün.

`spotify_oauth_state` bilerek dışarıda: geçici bir CSRF değeri, taşınması yanlış olur.

v3.13.0'ın yalnızca-eşleştirme yedeği de okunuyor (geriye dönük uyumluluk).

### install.sh için anlamsal kontrol

Bu sürümü yazarken `install.sh`'ta değişken tanımlarını yanlışlıkla sildim. `bash -n` geçti — çünkü sözdizimi geçerliydi — ama udev kuralı boş dosya adına yazılacaktı. Sessiz bozulma.

Artık ayrı bir kontrol var: kullanılan her `$DEĞİŞKEN` tanımlı mı, kritik satırlar (`plugininstallend`, `systemctl enable`, `chown`) yerinde mi, heredoc'lar dengeli mi. Sözdizimi kontrolü yeterli değil.

## v3.13.0 — karta elle isim ve kapak + kart kaybının kalıcı önlemi

### Kişisel listeler: API yolu kapalı, ölçüldü

v3.12.0 kütüphane kademesini ekledi ama işe yaramadı. Cihazda dört yolu da ölçtük:

| Yol | Sonuç |
|---|---|
| `/v1/playlists/{id}` | 404 |
| oEmbed | 404 |
| `/v1/me/playlists` | **200, 70 liste** — kişisel listeler içinde yok |
| `/v1/views/made-for-x` | **401** |

Kitaplıktaki 70 listenin tamamı isim isim tarandı; Blend başka bir kimlikle de yok. `/v1/views/*` uçlarının **401** (404 değil) dönmesi belirleyici: bu uçlar Spotify'ın kendi uygulamasına ayrılmış, üçüncü parti anahtarıyla açılmıyor.

Kovalamayı bıraktık. Kütüphane kademesi kodda kalıyor — normal listeler için çalışıyor ve zararsız.

### Karta elle isim ve kapak

Galeride karta tıkla → **"Kartın görünüşü"**. İsim yaz, görsel yükle, ya da sıfırla.

- Elle verilen isim/kapak Spotify'dan gelene **her zaman baskın**.
- Görsel tarayıcıda **800×800'e kare kırpılıp** küçültülüyor: cihaza görsel kütüphanesi kurmak gerekmiyor, telefondaki 4 MB'lık fotoğraf ağdan geçmiyor. 44 mm'lik kapak alanı için 300 DPI'ın epey üstünde.
- Görseller `card-images/` altına, **config'in yanına** yazılıyor — güncelleme silmiyor.
- Kartta hangi bilginin elle verildiğini gösteren küçük bir rozet var.

Güvenlik: kart kimliği dosya adına girdiği için `^[0-9A-Za-z_-]{1,64}$` dışındaki her şey reddediliyor (`../../etc/passwd` dâhil), görsel yalnızca PNG/JPEG/WebP (SVG **kabul edilmiyor** — script taşıyabilir), 3 MB üst sınır. 22 senaryo test edildi.

### Kart eşleştirmelerinin kaybı — kalıcı önlem

v3.12.0'da paketteki `config.json` şablonu boşaltılmıştı (kişisel kart listesi herkese açık depoda durmasın diye) ve **güncelleme 148 kartı sildi.**

Hatalı varsayım: "Volumio canlı config'i korur." Bu, şablonunda zaten aynı kartlar bulunan sürümler kurularak 'doğrulanmıştı' — oysa o gözlem "korunuyor" ile "aynı veriyle eziliyor" arasını ayırt edemiyordu.

Üç katmanlı önlem:

1. Eşleştirmeler her değiştiğinde config'in **yanına** ayrı bir kopya yazılıyor (`mappings-guvenlik-kopyasi.json`). Paketin içinde olmadığı için güncelleme onu ezemiyor.
2. Açılışta config boş ama kopya doluysa eklenti **kendi kendine geri yüklüyor** ve bildiriyor.
3. `install.sh` kuruluma başlamadan **önce** mevcut eşleştirmeleri güvenceye alıyor.

Boş liste asla dolu kopyayı ezmiyor; config doluysa kopya ona dokunmuyor (kullanıcı verisi her zaman üstün). 15 senaryo test edildi.

### "Failed to fetch" (v3.12.1)

Kütüphane çağrısında başarı önbelleğe alınıyordu ama **başarısızlık alınmıyordu**. İsmi çözülemeyen her kart kütüphaneyi baştan çekmeye kalkıyor, 148 kart × çok sayfalı istek dakikalar sürüyor, tarayıcı pes ediyordu. Artık başarısızlık da 60 sn önbellekleniyor (148 istek → 1 istek), yeniden yetkilendirmede önbellek anında temizleniyor, ve tüm taramaya 25 sn üst sınır kondu.

### config.yml sahipliği (v3.12.x)

Düzeltici root olarak çalışırken `os.replace` dosyayı yeniden yaratıyor ve sahibini root yapıyordu; Volumio kendi dosyasına yazamaz hale gelip go-librespot yöneticisini başlatamıyordu. Belirti sinsiydi: **müzik çalıyor ama arayüzde ve HDMI ekranında şarkı bilgisi yok.** Artık sahiplik ve izinler korunuyor, `install.sh` bozulmuş kurulumları onarıyor.

## v3.12.0 — kişisel listeler (Blend, Daily Mix, daylist) artık isimleriyle geliyor

İsim/kapak çözümlemesi artık **üç kademeli**:

| Kademe | Kaynak | Neyi çözer |
|---|---|---|
| 1 | `/v1/playlists/{id}` | Kullanıcının kendi oluşturduğu normal listeler |
| 2 | oEmbed (kimliksiz) | Herkese açık editoryal listeler (`37i9dQZF1DX...`) |
| 3 | **`/v1/me/playlists`** | **Kişiselleştirilmiş listeler: Blend, Daily Mix, daylist, Discover Weekly** |

Üçüncü kademe yeni. Bu listeler herkese açık olmadığı için ilk iki yol 404 veriyor — ama kullanıcı onları **takip ettiği** için kendi kitaplığında görünüyorlar.

Detaylar:

- Kitaplık tek seferde çekilip **10 dakika önbelleğe** alınıyor; 148 kartlık bir yenilemede tekrar tekrar istek atılmıyor.
- Eş zamanlı çağrılar **tek isteğe** düşüyor (in-flight paylaşımı).
- Sayfalama var, 20 sayfada (1000 liste) duruyor — bozuk bir `next` alanı sonsuz döngüye sokmasın.
- Spotify algoritmik listeleri bazen `null` döndürüyor; bunlar atlanıyor.
- **403 ≠ 404.** İzin yoksa Spotify 403 döner ("yetkin yok"), 404 değil ("liste yok"). Bu durumda kullanıcıya ham hata değil, ne yapması gerektiği söyleniyor: yetkilendirmeyi yenile.
- Yetkilendirme hiç yoksa istek bile atılmıyor.

"Tüm İsimleri Yenile" sonucu artık **hangi ismin nereden geldiğini** söylüyor — kütüphane kademesinin gerçekten işe yarayıp yaramadığı, ayrı bir teşhis script'i çalıştırmadan görülüyor.

**Not:** Bu kademe, işe yarayacağı cihazda ölçülmeden önce yazıldı — bilerek ve bilerek savunmacı. Başarısız olduğunda sessizce bir önceki davranışa (isim boş kalır) düşüyor; en kötü ihtimalde hiçbir şey bozulmuyor.

## v3.11.1 — kullanım kılavuzu

`README.md` bir değişiklik günlüğüydü: 20 sürüm notu, kurulum adımları en altta gömülü. İki yıl sonra açan biri aradığını bulamazdı.

Ayrıldı:

- **README.md** — kullanım kılavuzu: kurulum (sudo tuzağı dâhil), ilk ayarlar, yedekleme, eklentinin sistemde neye dokunduğu, sorun giderme tablosu, dosya/komut kılavuzu, bilinen sınırlar.
- **CHANGELOG.md** — bu dosya, sürüm geçmişi arşivi.

Sorun giderme tablosu bu projede gerçekten yaşanmış her arızayı içeriyor: belirti → sebep → komut. Bir de en pahalı ders not düşüldü: *boş çıktı her zaman "yok" demek değildir* — `grep ExecStartPre` boş dönüyordu, bunu "drop-in kurulmamış" sandık; oysa servis o boot'ta hiç çalışmamıştı.

## v3.11.0 — yedekleme ve geri yükleme

Kart eşleştirmeleri bu projenin **yerine konamaz** tek parçası. Kod her zaman yeniden yazılır; 148 kartı tek tek okutup yeniden eşlemek saatler alır. Hepsi tek bir dosyada, tek bir SD kartta duruyordu — ve Raspberry Pi'lerde en sık görülen arıza SD kartın ölmesi.

Galeri sayfasına **Yedekle / Geri Yükle** bölümü eklendi.

### Yedek

`Yedeği İndir` düğmesi, tarayıcıya doğrudan bir JSON dosyası indiriyor: eşleştirmeler, çekilmiş isimler/kapaklar ve çalma istatistiği.

**Kimlik bilgileri bilerek dâhil edilmiyor.** Yedek dosyası bilgisayara kopyalanacak, e-postayla gönderilecek, buluta atılacak bir dosya; içine client secret ve refresh token koymak onu bir sızıntı riskine çevirir. Kaybolduklarında yeniden elde etmek kolay: secret Spotify panelinden kopyalanır, token bir kez yetkilendirmeyle yenilenir. Eşleştirmelerin ise başka kopyası yok.

### Geri yükleme

İki yöntem var ve fark açıkça yazıyor:

- **Birleştir** (varsayılan) — yedektekiler eklenir/güncellenir, yedekte olmayan kartlar **kalır**.
- **Değiştir** — eşleştirmeler birebir yedektekiler olur.

Güvenlik önlemleri:

- **Geri yüklemeden önce mevcut durum otomatik olarak diske yazılıyor**, dosya yolu ekranda gösteriliyor. Yanlış bir geri yükleme geri alınabilir.
- Dosya sıkı doğrulanıyor: format alanı, sürüm, kart ID ve URI biçimi. Geçersiz kayıtlar sessizce atlanmıyor — kaç tanesinin atlandığı söyleniyor.
- `Değiştir` seçiliyken onay kutusu ne olacağını açıkça yazıyor.
- Eldeki **taze isimler eski bir yedekle geri gitmiyor**; çalma istatistiğinde de iki kayıttan **yüksek sayaçlı** olan korunuyor.

### Test

Mantık tarafında 30 senaryo (bozuk JSON, dizi, yanlış format, gelecek sürüm, geçersiz URI, `../../etc/passwd` gibi kart ID'leri, boş dosya), tarayıcı tarafında 19 kontrol — gerçek dosya indirme, gerçek dosya seçme, iki geri yükleme yönteminin sonucu.

Kimlik sızıntısı için hem **alan** hem **değer** bazlı test var: config'e sahte bir secret konsa bile yedeğe geçmiyor.

## v3.10.2 — Volumio arayüzünde şarkı bilgisinin kaybolması (sahiplik hatası)

### Belirti

Müzik çalıyordu ama Volumio arayüzünde ve HDMI ekranında **ne çaldığı görünmüyordu**. Ses vardı, bilgi yoktu.

### Sebep

Volumio log'unda:

```
error: Failed to write spotify config file: EACCES: permission denied,
       open '/data/go-librespot/config.yml'
error: Error initializing go-librespot daemon
```

Hata bizimdi. `install.sh`, düzelticiyi **root** olarak çalıştırıyor; düzeltici de dosyayı geçici dosya + `os.replace` ile yeniden yazıyordu. `os.replace` dosyayı **yeniden yaratıyor**, dolayısıyla yeni dosyanın sahibi root oluyordu. Volumio ise `volumio` kullanıcısı olarak çalışıyor — kendi config dosyasına yazamaz hale geldi.

Zincir şöyle işledi: Volumio go-librespot yöneticisini başlatamadı → durum dinleyicisini bağlayamadı → müzik go-librespot üzerinden çalmaya devam etti ama Volumio ne çaldığını öğrenemedi.

Belirtinin sinsiliği buradaydı: **ses geldiği için "çalışıyor" sanılıyordu.** Sistemin görünen yüzü (arayüz, HDMI ekranı) bozuktu ama sesli test bunu yakalamıyordu.

### Düzeltme

1. `fix_librespot_config.py` artık dosyanın **sahipliğini ve izinlerini koruyor**: orijinalin `uid/gid/mode` değerlerini okuyup geçici dosyaya uyguluyor, ondan sonra yerine koyuyor. Hata olursa geçici dosyayı temizliyor.
2. `install.sh`, daha önce bozulmuş kurulumları **onarıyor**: servisin `User=` değerini okuyup config.yml'in sahipliğini ona geri veriyor.

Elle onarım (v3.9.x–v3.10.1 kurulmuş cihazlarda):

```
sudo chown volumio:volumio /data/go-librespot/config.yml
sudo systemctl restart volumio
```

### Test

Hatayı **yeniden üreten** bir test yazıldı: dosya `volumio`'ya ait, script root olarak çalışıyor. Eski yöntem sahipliği `uid 1000 → 0` yapıyor (doğrulandı), yeni yöntem `1000` bırakıyor. Ayrıca 0600/0640/0644/0664 izinlerinin korunduğu, geçici dosya artığı kalmadığı ve değişiklik gerekmiyorsa dosyaya hiç dokunulmadığı test edildi.

## v3.10.1 — sıralama seçiminin geri sıçraması

Galeride sıralamayı değiştirince bir saniye sonra eski sıraya dönüyordu.

Sayfa 4 saniyede bir sunucuyu yokluyor. Seçim yapıldığında yola çıkmış bir `/api/state` isteği, seçimi kaydeden POST'tan **sonra** dönebiliyor ve eski değeri taşıyor. "Kullanıcı seçim yapıyorsa yoklamayı yok say" bayrağını POST bitince sıfırlıyordum; geç dönen yanıt tam o aralığa denk gelince seçimi eziyordu.

Sunucu değeri artık **yalnızca ilk yüklemede** kullanılıyor; kullanıcı bir kez seçim yaptıysa o oturumda hiçbir yoklama onu değiştiremiyor.

Bu hata, sayfa **gerçek bir tarayıcıda** (headless Chromium) çalıştırılarak bulundu — birim testleri yakalayamazdı, çünkü hata iki isteğin zamanlamasındaydı. Aynı koşuda sekme geçişleri, arama, rozet çakışması (kutu koordinatlarıyla) ve baskı sayfasının sıralamadan etkilenmediği de doğrulandı.

## v3.10.0 — galeri sıralaması

Kartlar `Object.keys(mappings).sort()` ile, yani **kart seri numarasına** göre diziliyordu. 148 kart 142 kopuk numara bloğuna dağılmış durumda; pratikte bu "kartları hangi paketten aldığın" demek, içerikle hiç ilgisi yok.

Artık galeride dört sıralama var, seçim cihazda saklanıyor (telefonla masaüstü aynı sırayı görüyor):

| Sıralama | Ne yapar |
|---|---|
| **Son zamanlarda en çok çalınan** (varsayılan) | Eriyen puan — aşağıda |
| En son çalınan | Son okuttuğun kart en üstte |
| İsme göre (A–Z) | Türkçe alfabe; Ç/Ğ/İ/Ö/Ş/Ü doğru yerde |
| Kart numarası | Eski davranış, sabit sıra |

### Neden düz "en çok çalınan" değil

Düz frekans muhafazakâr: Ocak'ta 50 kez çalınan bir kart, bir daha hiç çalınmasa bile aylarca tepede kalır ve yeni kartlar asla tırmanamaz. Düz "son çalınan" ise fazla oynak — üstelik az önce çaldığın kartı zaten elinde tutuyorsun, en üstte görmek sana yeni bilgi vermiyor.

Bu yüzden eriyen puan: her çalma **+1**, puanlar **30 günde yarılanıyor**.

```
puan = eski_puan × 0.5^(geçen_gün / 30) + 1
```

Ölçülen davranış (testlerden):

- Her gün çalınan kart **~43.8** puanda dengeleniyor.
- 6 ay önce bir hafta içinde 50 kez çalınıp bırakılan kart **0.76**'ya düşüyor — yani geçen hafta iki kez çalınan kartın (**1.70**) altına iniyor.
- 60 gündür her gün çalınan bir favori varken, 10 günlük yeni bir kart onun **%35** seviyesine çıkabiliyor; yani yeni kartlar içeri girebiliyor.

Kart başına dört sayı tutuluyor: ham sayaç, son çalma zamanı, puan, puanın damgası. Her çalmanın geçmişini saklamaya gerek yok — erime tek satırlık formül. Ham sayaç **erimiyor**, o yüzden rozette gerçek toplam görünüyor.

### Kararlar

- **Baskı sırası bundan etkilenmiyor.** Baskı sayfası hep kart numarası sırasında; aynı sayfayı yeniden bastığında hep aynı 9 kart gelsin diye. Sunucu listeyi zaten kart numarası sırasında gönderiyor, sıralamayı tarayıcı yapıyor.
- **Rozet sadece ekranda** (`42×`, sağ alt köşe, soluk). Basılan karta yazılmıyor: fiziksel kartın üstündeki sayı bir süre sonra yanlış bilgi olur ve kartı yeniden basmadan güncellenemez.
- **Eşitlik bozucu her zaman kart numarası.** Aynı puandaki kartlar her yenilemede yer değiştirmiyor, sıra kararlı.
- **Aynı kartın tekrar okutulması sayılmıyor.** O dal "sonraki şarkıya geç" ile erken çıkıyor; şarkı atlamak kartı bir kez daha çalmak değil.
- Puan erimesi **sunucuda** hesaplanıp gönderiliyor — tarayıcının saati yanlışsa sıralama bozulmasın diye.

### Test

Sıralama ve erime fonksiyonları, kaynak dosyalardan **çıkarılıp** test edildi (kopyalanıp yeniden yazılmadı — test edilen kodun gönderilen kod olmaması riskine bu projede bir kez düşmüştük). 30 senaryo: yarılanma doğruluğu, denge noktası, terk edilen kartın süzülmesi, yeni kartın tırmanabilmesi, Türkçe harf sırası, isimsiz kartlar, bozuk/eksik veri, saatin geri gitmesi, sıranın kararlılığı, girdi dizisinin değişmemesi.

İki hata bu testlerde yakalandı: `decayScore` eksik zaman damgasında puanı **sıfırlıyordu** (artık koruyor — bilmediğimiz için veriyi silmek yanlış), ve çalma sayısı rozeti "çalıyor" rozetiyle **aynı köşedeydi** (sağ alta alındı).

## v3.9.4 — kişiselleştirilmiş listeler için kitaplık izinleri

Blend, Daily Mix, Discover Weekly gibi **kişiselleştirilmiş** listelerin ismi ve kapağı gelmiyordu. Cihazda üç yolu birden ölçtük:

| Liste | `/v1/playlists/{id}` | `/v1/me/playlists` | oEmbed |
|---|---|---|---|
| Blend | 404 | **403** | 404 |
| kontrol (herkese açık editoryal) | 404 | **403** | **OK** |

İki sonuç çıktı:

1. **`/v1/playlists/{id}` tamamen ölü.** Kullanıcı token'ıyla bile, oEmbed'in sorunsuz çözdüğü herkese açık bir listede bile 404 veriyor. Spotify'ın Kasım 2024 kısıtlaması `37i9dQZ...` kimliklerini üçüncü parti uygulamalara kapatmış. Bu yolu bir daha denemiyoruz.

2. **`/v1/me/playlists` 403 döndü — 404 değil.** Yani "liste yok" değil, "iznin yok". Sebep bizdeydi: yetkilendirme sadece çalma izinleri istiyordu (`user-modify-playback-state`, `user-read-playback-state`). Kitaplık okumak `playlist-read-private`, ortak listeler (Blend) `playlist-read-collaborative` istiyor.

Bu sürüm o iki izni de istiyor. **Yetkilendirmeyi yenilemek gerekiyor** — refresh token, verildiği andaki izinlere bağlı, eski token yeni izinleri kazanmaz.

Not: bu, kişiselleştirilmiş listelerin çözüleceğini garanti etmiyor. Spotify aynı kısıtlamayla algoritmik listeleri kitaplık yanıtından da eleyebiliyor. İzinler eklendikten sonra `teshis_playlist.py` tekrar çalıştırılıp ölçülmeli. Çıkmazsa çözüm, o kartlara elle isim/kapak vermek olacak.

## v3.9.3 — ASIL sebep bulundu: servis açılışta hiç başlamıyormuş

### Kök sebep

Aylarca "reboot sonrası hiçbir şey çalmıyor, telefondan bir kez cast edince düzeliyor" sorununu `credentials.type` ayarında aradık. O gerçek bir sorundu ve v3.9.0-3.9.2'de çözüldü. Ama altında bir katman daha varmış:

```
Loaded: loaded (/lib/systemd/system/go-librespot-daemon.service; disabled; preset: enabled)
Active: inactive (dead)
```

**go-librespot-daemon systemd'de `disabled` durumdaydı — yani açılışta hiç başlamıyordu.** Başlamayan bir servis için credentials ayarının doğru olması hiçbir işe yaramaz. Telefondan cast etmek servisi ayağa kaldırdığı için sorun "cast edince düzeliyor" gibi görünüyordu; oysa cast, iki katmanı birden atlatıyordu.

Bu, teşhisi de aylarca yanılttı: `systemctl status | grep ExecStartPre` boş dönüyordu ve bunu "drop-in kurulmamış" sandık. Oysa systemd, o boot'ta hiç çalışmamış bir servis için `Process:` satırını basmıyor — boş çıktı "drop-in yok" değil, "servis ayakta değil" demekti.

Unit dosyasında `[Install] WantedBy=multi-user.target` var ve preset `enabled`. Yani servis zaten açılışta başlamak üzere tasarlanmış; `disabled` olması anormallikti.

### Düzeltme

`install.sh` artık servisin açılışta başlayıp başlamadığını kontrol ediyor ve gerekiyorsa `systemctl enable` yapıyor. Ama **önce mevcut durumu kaydediyor** (`mecazicards-prior-enable-state`), `uninstall.sh` da eklenti kaldırılırken bulduğu hâle geri döndürüyor. Kurulumdan önce zaten `enabled` idiyse dokunulmuyor — o Volumio'nun kendi tercihi.

İlke: **başka bir servisin ayarına dokunuyorsak, dokunduğumuzu geri alabiliyor olmalıyız.**

Doğrulama (cihazda, soğuk açılıştan, telefona hiç dokunmadan):

```
22:07:02  [librespot-fix] ayar zaten doğru (saklı kimlik: var), dokunulmadı
22:07:04  zeroconf server listening on port 35129
22:07:05  authenticated AP      username="me*az"
22:07:05  authenticated Login5  username="me*az"
```

### Sadeleştirme: ikinci mekanizma kaldırıldı

Eklentide, başladıktan 45 sn sonra config'i kontrol edip gerekirse go-librespot'u yeniden başlatan bir yedek zamanlayıcı vardı (`scheduleLibrespotCheck` / `ensureLibrespotAutoLogin`, ~72 satır). Kaldırıldı:

- **Gereksizdi**: systemd adımının doğru anda çalıştığı kanıtlandı — düzeltici, go-librespot'tan 2 saniye önce çalışıyor.
- **Riskliydi**: arka planda komşu bir servisi habersiz yeniden başlatmak, onu Spotify Connect listesinden düşürebilir. Bir gece tam olarak bu yaşandı.

İki yarım mekanizma taşımaktansa, doğru anda çalışan tekini taşıyoruz.

### Düzelticiye kimlik geçerlilik kontrolü

`fix_librespot_config.py` eskiden sadece "alanlar dolu mu" diye bakıyordu. Kimlik bozuksa `interactive` kipine geçmek go-librespot'u düşürebilir ve cihaz Connect listesinden tamamen kaybolur. Artık blob'un base64 olarak çözülebildiği ve makul uzunlukta olduğu da doğrulanıyor; şüphedeyse güvenli tarafa (`zeroconf`) düşüyor — en kötü ihtimalle "bir kez cast et" durumuna döneriz, sessizce ölmeyiz.

Kontrol bilerek **toleranslı**: standart ve URL-güvenli base64'ü, eksik dolgu ihtimaliyle birlikte deniyor. Sağlam bir kimliği lehçe farkı yüzünden "bozuk" ilan edip çalışan kurulumu bozmak, yakalamaya çalıştığımız hatadan daha kötü olurdu. 21 senaryoyla test edildi.

### Kurduktan sonra

```
systemctl is-enabled go-librespot-daemon     # enabled
systemctl is-active  go-librespot-daemon     # active
```

Sonra reboot et ve telefona hiç dokunmadan bir kart okut.

## v3.9.2 — açılış düzelticisi neden hiç çalışmamıştı (`//fix_librespot_config.py`)

v3.9.0'da eklenen systemd drop-in kuruluyordu, `systemctl status` çıktısında görünüyordu, ama **hiç çalışmıyordu**. Senin gönderdiğin çıktı meseleyi tek satırda çözdü:

```
Process: 6474 ExecStartPre=/usr/bin/python3 //fix_librespot_config.py (code=exited, status=2)
```

Yoldaki çift eğik çizgiye dikkat: `//fix_librespot_config.py`. `status=2` "dosya bulunamadı" demek. Hata benimdi: `install.sh` içinde düzelticinin yolunu `INSTALLING_DIR=$(pwd)` üzerinden kuruyordum. Volumio Plugin Manager `install.sh`'ı **`/` dizininden** çalıştırdığı için değişken `/` oluyor, `"$INSTALLING_DIR/fix_librespot_config.py"` de `//fix_librespot_config.py` haline geliyordu. go-librespot her açılışta bu adımı çalıştırmayı deniyor, dosyayı bulamıyor, `-` öneki sayesinde sessizce devam ediyordu — yani ne servis patlıyordu ne de bir hata görüyorduk. Reboot sonrası hiçbir şeyin çalmamasının sebebi tam olarak buydu.

Düzeltme üç katmanlı:

1. Yol artık önce eklentinin **kurulu olduğu bilinen** yerden alınıyor: `/data/plugins/system_hardware/mecazicards_for_spotify/fix_librespot_config.py`.
2. Orada yoksa sırasıyla script'in kendi dizinine (`BASH_SOURCE`) ve `INSTALLING_DIR`'e bakılıyor — `INSTALLING_DIR` `/` ise **kullanılmıyor**.
3. Hiçbirinde bulunamazsa drop-in **hiç yazılmıyor** ve ekrana uyarı basılıyor. Var olmayan bir dosyayı gösteren bir açılış adımı bırakmaktansa, mekanizmayı hiç kurmamak daha dürüst.

Ayrıca kurulumun sonuna bir **doğrulama** adımı eklendi: `systemctl show go-librespot-daemon -p ExecStartPre --value` çıktısındaki `status=` okunuyor ve `status=0` değilse kurulum ekranında uyarı gösteriliyor. Bu sessiz başarısızlık bize günler kaybettirdi; bir daha sessizce geçmesin.

Eklentinin kendi yedek mekanizması (`onStart`'tan 45 sn sonra çalışan `ensureLibrespotAutoLogin`) aynen duruyor. İkisi birden çalışıyor: drop-in *doğru* zamanda (go-librespot config'i okumadan hemen önce), yedek mekanizma ise drop-in bir sebeple devre dışıysa emniyet kemeri olarak.

### Kurduktan sonra kontrol etmen gerekenler

```
systemctl status go-librespot-daemon --no-pager | grep ExecStartPre
```
Yolda çift eğik çizgi olmamalı ve `status=0` görmelisin. Sonra **reboot et** ve telefondan hiç cast etmeden bir kart okut — çalması lazım.

## v3.7.1 — çalan kart vurgusu amber oldu

Çalan kartın çerçevesi ve "çalıyor" rozeti yeşildi. Sorun şuydu: alt bantta zaten Spotify'ın yeşili var, kapak görselleri de yeşil olabiliyor — vurgu bu üçünün arasında kayboluyordu. Özellikle yeşil kapaklı kartlarda "hangisi çalıyor" ayırt edilemiyordu.

Vurgu artık amber (#FFB020). Hem kapaklardan hem Spotify'ın renginden ayrışıyor, marka turkuazıyla da çakışmıyor. Marka rengi değişmedi — turkuaz aynen duruyor; amber yalnızca "durum" rengi olarak kullanılıyor.

## v3.7.0 — marka logosu artık vektör

Marka, Kestrel Script fontundan **vektör yola** çevrildi ve `web/brand-logo.svg` olarak pakete kondu (7 KB). Önceki PNG kaldırıldı.

Neden önemli: PNG 496 piksel genişliğindeydi, kartta yeterliydi ama ölçek büyüdükçe bozuluyordu. Vektör her boyutta net — kartta 54 mm'de de, ön panelde 200 mm'de de.

Doğrulama: fonttan üretilen yazı, ön panelin orijinal görselinin üzerine bindirildiğinde **%80.5** örtüşme veriyor (kalan fark, 489 piksellik kaynak görselin antialias'ı). Karşılaştırma için, fontu bilmeden yaptığım en iyi tahmin %45'te kalmıştı.

Orijinaldeki harf aralığı da ölçülerek bulundu: **tracking 18** (1/1000 em). Bu değerle en/boy oranı 7.084 çıkıyor, panelin orijinali 7.087.

## v3.6.1 — açık zemin baskısında marka rengi

Marka turkuazının (#29C4A1) beyaz üzerindeki kontrastı ölçüldüğünde **2.21:1** çıkıyor — okunaklılık eşiği olan 4.5:1'in epey altında. Koyu kartlarda sorun yok (8.75:1), ama baskının "Açık zemin (mürekkep tasarrufu)" seçeneğinde kart beyaza döndüğü için marka soluk kalıyordu.

Düzeltme: açık zemin baskısında marka aynı tonun koyu varyantına çevriliyor (~#16856C, beyaz üzerinde **4.6:1**). Koyu kartlarda ve ekranda orijinal turkuaz aynen duruyor.

## v3.6.0 — kartlarda mecaziradio markası

Kartların üst bandındaki Volumio kelime logosunun yerini artık **mecaziradio** markası alıyor (ön panel tasarımından alınan turkuaz yazı, Kestrel Script). Alt bant değişmedi: solda Spotify, sağda Raspberry Pi.

Marka görseli `web/brand-logo.png` olarak pakete gömülü. Değiştirmek istersen aynı klasöre kendi dosyanı koyman yeterli (`.png`, `.svg`, `.jpg`, `.webp`):

```
/data/plugins/system_hardware/mecazicards_for_spotify/web/brand-logo.png
```

**Vektör sürüm önerilir.** Şu an kullanılan görsel 497 piksel genişliğinde; kartta ~35 mm basıldığı için 361 dpi'ye denk geliyor, yani baskı için yeterli. Ama markayı ileride daha büyük kullanacaksan (ön panel, kutu, afiş), Photoshop'ta metin katmanına sağ tıklayıp **Convert to Shape** dedikten sonra SVG olarak dışa aktarıp `web/brand-logo.svg` adıyla koyman daha iyi olur — o zaman hiçbir boyutta bozulmaz.

Dosyayı silersen kart otomatik olarak Volumio kelime logosuna geri döner, hiçbir şey kırılmaz.

## v3.5.1 — düzeltme: uzun isimler tür yazısının üstüne biniyordu

v3.5.0'da uzun isimli kartlarda (ör. iki satırı aşan sanatçı/liste adları) başlığın üçüncü satırı yarım kesiliyor ve altındaki "SANATÇI" / "ÇALMA LİSTESİ" yazısının üzerine biniyordu.

Sebebi ince bir flexbox davranışı: başlık, esnek kutu içinde `flex-shrink: 1` olduğu için yer daralınca **kutusu küçültülüyordu**. Kutu küçülünce `-webkit-line-clamp: 3` kuralı devreye giremiyor, dolayısıyla "…" da eklenmiyor, metin düz kesiliyordu.

Düzeltme: başlık ve tür satırı artık sıkışmıyor (`flex-shrink: 0`) ve belirgin başlıklar 3 yerine **2 satırla** sınırlı. Böylece uzun isimler temiz bir "…" ile bitiyor, hiçbir şeyin üstüne binmiyor. İsmin tamamını görmek istersen karta tıklayınca açılan pencerede zaten tam hâli yazıyor.

Bu durum, kasten uzun isimlerle (76 karaktere kadar) hazırlanmış dokuz kartlık bir baskı sayfası üretilip her kartın başlık kutusu ile alt bandın koordinatları ölçülerek doğrulandı.

## v3.5.0 — kart tipografisi: daha büyük üst/alt bant

Baskı denemesinde logoların küçük kaldığı, Volumio kelime logosunun harflerinin birbirine girdiği ve "ÇALMA LİSTESİ" satırı ile alt bant arasında boşluk kaldığı fark edildi. Kartın toplam yüksekliği (85.6 mm) sabit olduğu için o boş alan üst ve alt banda dağıtıldı:

| | v3.4.0 | v3.5.0 |
|---|---|---|
| Volumio kelime logosu | 12 px, çizgi kalınlığı 4.2 | **16 px, çizgi 3.4** |
| RFID sembolü | 15 px | **19 px** |
| Spotify / Raspberry | 14 px | **18 px** |
| Başlık | 11.5 px | **12.5 px** |
| Üst bant boşluğu | 7/8/5 px | **10/10/8 px** |
| Alt bant boşluğu | 6/9/8 px | **9/10/10 px** |

Volumio logosundaki çizgi kalınlığı hem **büyütülüp** hem **inceltildi**: harflerin birbirine girmesinin sebebi boyut değil, çizginin harf boyuna oranıydı (%19 → %15). Kapak görselinin boyutu değişmedi — kartın yıldızı o.

Ayrıca başlık bloğu artık kalan alanda dikey ortalanıyor, böylece alt bantla arasında asimetrik bir boşluk kalmıyor.

Baskı sayfasındaki **© designed by mecaz** imzası sağa yaslandı, italik yapıldı ve sağ kenarı kart ızgarasının sağ kenarıyla hizalandı.

## v3.4.0 — sticker baskı sekmesi ve yerel çalmada "çalıyor" işareti

### Düzeltme: yerel çalmada çalan kart işaretlenmiyordu

Spotify Connect ile çalarken kart doğru işaretleniyordu ama Volumio'nun kendi (yerel) mekanizmasıyla çalarken hiçbir şey vurgulanmıyordu. Sebebi: "şu an ne çalıyor" bilgisini yalnızca Spotify'ın Connect API'sinden okuyorduk, yerel çalmadan Spotify'ın haberi olmuyor.

Artık Connect bir şey söylemezse Volumio'nun kendi oynatma durumuna bakılıyor. Volumio bize sadece çalan **parçayı** söylüyor, hangi listeden geldiğini değil; o yüzden "en son hangi kart okutulduysa o çalıyordur" çıkarımı yapılıyor. Bu bir tahmin olduğu için arayüzde açıkça yazıyor: *"son okutulan karta göre"*. Yanlış olabileceği tek durum, kartla değil elle Volumio arayüzünden başka bir şey başlatman; bunu sınırlamak için sadece Spotify servisi (`spop`) çalarken işaretleniyor.

### Yeni: Baskı sekmesi (A4 sticker sayfası)

Galerinin yanına **"Baskı"** sekmesi eklendi. Oradan kartları tek tek seçip (ya da "Tümünü Seç" ile) yazdırabiliyorsun:

- **A4 dikey, 3 × 3 = sayfa başına 9 kart.** Fazlası otomatik olarak sonraki sayfalara taşıyor, kaç sayfa olacağını üstte gösteriyor.
- **Gerçek kart boyutu**: her kart tam **54 × 85.6 mm** (ID-1, banka kartı ölçüsü) basılıyor.
- **Köşe kesme işaretleri**: her kartın dört köşesinde, kartın dışına taşan ince L işaretleri. Kartın üstüne çizgi gelmiyor.
- **Aradaki boşluklar beyaz** — mürekkep israfı yok.
- **"Açık zemin (mürekkep tasarrufu)"** seçeneği: kart zeminini beyaza, yazıları koyuya çevirir. Kapak görselleri yine renkli basılır ama koyu zemin harcamazsın.
- Altta **© designed by mecaz** imzası.

**PDF nasıl alınıyor:** "PDF Olarak Kaydet / Yazdır" düğmesi tarayıcının yazdırma penceresini açar; hedef olarak "PDF olarak kaydet" seçmen yeterli. Bunu bilerek böyle yaptım — tarayıcının kendi PDF motoru yazıları vektör olarak gömüyor, JavaScript ile üretilen PDF'lerden daha temiz çıkıyor ve eklentiye megabaytlarca kütüphane eklemek gerekmiyor.

**Önemli:** Yazdırma ayarlarında **ölçek %100** ve **kenar boşlukları "Yok/None"** olmalı. Aksi halde tarayıcı sayfayı küçültür ve kartlar 54 × 85.6 mm'den ufak çıkar.

## v3.3.0 — çalma yöntemi seçimi, hedef cihaz sabitleme, kart galerisi düzenlemeleri

### Çalma yöntemi artık seçilebiliyor

Yerel çalma (Volumio'nun kendi mekanizması) senin cihazında tekrar çalışmaya başladığı için, tek bir yönteme mecbur kalmak yerine seçenek koydum. Hem Volumio ayarlar sayfasında ("Çalma Yöntemi" bölümü) hem de kart galerisinde:

| Mod | Ne yapar | Ne zaman |
|---|---|---|
| **Otomatik** (varsayılan) | Önce Spotify Connect'i dener; hata alırsa Volumio'nun kendi yöntemine düşer | Günlük kullanım |
| **Sadece Spotify Connect** | Yalnızca Connect; başarısız olursa sessizce yerele düşmez, hatayı gösterir | Sorun ararken, ya da müziği hep belirli bir cihazda istiyorsan |
| **Sadece yerel** | Volumio'nun kendi mekanizması; Spotify hesabına hiç istek gitmez | İnternet/yetkilendirme derdi olmadan, en düşük gecikme |

### Spotify Connect hedef cihazını sabitleme

Connect komutları hesabındaki **aktif** cihaza gidiyordu — bu yüzden Mac'inde veya TV'nde müzik çalarken kart okuttuğunda oradaki çalma değişiyordu. Artık galeri sayfasındaki "Çalma Yöntemi ve Hedef Cihaz" bölümünden **"Cihazları Tara"** deyip `mecaziradio`'yu seçebilirsin. Sabitlersen:

- Komutlar her zaman o cihaza gider, müzik oraya taşınır.
- Sabitlenen cihaz o an listede görünmüyorsa eklenti **başka bir cihaza komut göndermez**, açık bir hata verir. (Eskiden listedeki ilk cihaza düşüyordu — Mac'i kaçırmasının sebebi buydu.)

### Kart galerisi

- **Logolar yer değiştirdi**: sol altta Spotify, sağ altta Raspberry Pi. Üst solda Volumio'nun kelime logosu (orijinaline uygun şekilde çizildi — "o" harfleri yeşil ibreli birer ses düğmesi), üst sağda RFID sembolü. Her köşede bir logo.
- **Seri numarası kart yüzünden kalktı** — zaten kartların arkasında yazıyor. Numaraya ihtiyacın olursa karta tıkladığında açılan pencerede duruyor.
- **Çalan kart vurgulanıyor**: o an çalan içeriğe karşılık gelen kartın çevresinde yeşil çerçeve ve "▶ çalıyor" rozeti çıkıyor. Bu bilgi Spotify Connect'ten okunuyor, yani müziği telefondan başlatmış olsan bile doğru kart işaretleniyor.
- **Karta tıklayınca düzenleme penceresi**: kart numarası, URI ve iki düğme — "Eşleştirmeyi Değiştir" (formu doldurup oraya götürür) ve "Sil".
- **Başlıklar**: playlist ve albüm kapaklarında ismin kendisi görselin üstünde basılı geldiği için o başlıkları ikincil (küçük, sönük) gösteriyoruz; sanatçı kapaklarında isim yazmadığı için orada başlık belirgin kalıyor. Kapak görseli hiç yoksa başlık her hâlükârda belirgin.
- **Durum panelinde** "Son okunan kart" artık numarayla birlikte eşleştiği listenin/sanatçının adını da yazıyor; yanına da "Şu an çalan" kutusu eklendi.

## v3.2.0 — playlist isimlerinin boş kalması (Spotify'ın API kısıtlaması)

Kartların çoğunda isim/kapak boş kalıyordu. Sebebi bizim kodumuz değil: Spotify, **Kasım 2024'te** kendi hazırladığı **editoryal ve algoritmik çalma listelerini** Web API'ye kapattı. ID'si `37i9dQZF1...` ile başlayan listelerin (Türkçe Rock, Top 50, Discover Weekly, "... Mix" gibi Spotify'ın kendi listeleri) `/v1/playlists/{id}` ucu artık **404** dönüyor — hangi uygulama, hangi token olursa olsun. Senin 148 kartının büyük çoğunluğu tam da bu tipte olduğu için isimler boş kalıyordu. Sanatçı kartları ve kendi oluşturduğun listeler etkilenmiyordu, onlar zaten geliyordu.

**Çözüm:** Spotify'ın herkese açık **oEmbed** ucu (`open.spotify.com/oembed`) bu listeler için hâlâ başlık ve kapak görseli veriyor ve hiçbir kimlik doğrulaması istemiyor. Eklenti artık önce resmi Web API'yi deniyor, o başarısız olursa otomatik olarak oEmbed'e düşüyor. "Tüm İsimleri Yenile" sonucunda kaç tanesinin yedekten geldiğini de yazıyor.

Yan fayda: oEmbed hiçbir şey istemediği için, Client ID/Secret hiç girmesen bile isimler ve kapaklar artık gelebiliyor.

### Logoları kendi görsellerinle değiştirme

Raspberry Pi ve Spotify logoları paketin içinde hazır geliyor (`web/raspberry-logo.png`, `web/spotify-logo.png` — senin gönderdiğin görsellerden kırpılıp saydam zeminli hâle getirildi). Volumio logosu ise **cihazının kendi dosyalarından** otomatik bulunuyor, yani sende kurulu Volumio sürümünün gerçek logosu görünür.

Herhangi birini değiştirmek istersen, istediğin görseli eklentinin `web` klasörüne şu isimlerle koyman yeterli (`.png`, `.svg`, `.jpg`, `.webp` olabilir):

```
/data/plugins/system_hardware/mecazicards_for_spotify/web/volumio-logo.png
/data/plugins/system_hardware/mecazicards_for_spotify/web/raspberry-logo.png
/data/plugins/system_hardware/mecazicards_for_spotify/web/spotify-logo.png
```

Dosyayı koyduktan sonra eklentiyi yeniden başlat (ya da `sudo systemctl restart volumio`). Dosya yoksa veya bozuksa, kart sayfadaki yerleşik SVG çizimine düşer — hiçbir şey kırılmaz.

Not: Kart zemini koyu olduğu için koyduğun görselin **açık renkli / saydam zeminli** olması gerekiyor. Koyu gri Volumio kelime logosunu (beyaz zemin için olan sürümü) koyarsan kartta görünmez.

### Bilinen sınırlama

Bu OAuth/Connect kodunu (yetkilendirme akışı, token yenileme, `/v1/me/player/*` çağrıları) ben bu sohbetin çalıştığı ortamdan Spotify'ın sunucularına ağ erişimim olmadığı için canlı test edemedim — resmi Spotify Web API sözleşmesine dayanarak yazdım ve kodun kendisini (sunucu route'ları, JSON gövdeleri, hata yönetimi) sahte verilerle uçtan uca test ettim. Cihazında ilk denemede bir sorun çıkarsa, özellikle yetkilendirme sonrası gelen hata mesajını bana ilet.

### Not: eski `mecazicards-standalone` paketini kurma

Bu sohbetin daha önceki bir aşamasında, `volumio plugin install` sorununu (o zaman kök sebebi yanlış teşhis etmiştik) atlatmak için ayrı, bağımsız bir systemd servisi de hazırlamıştık. O sorunun gerçek sebebi (sudo/kullanıcı çakışması) bulununca artık gerek kalmadı ve galerisi de doğrudan bu eklentiye taşındı. **O bağımsız paketi bu eklentiyle birlikte kurma** — ikisi de aynı RFID okuyucu cihazını (`EVIOCGRAB`) kilitlemeye çalışır ve her kart okutuşta çifte tetikleme/çakışma olur.

