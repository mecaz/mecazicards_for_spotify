'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const nodeUrl = require('url');
const querystring = require('querystring');
const { spawn } = require('child_process');

// HID scancode -> rakam eşlemesi (Sycreader RFID okuyucunun gönderdiği
// standart USB HID keyboard scancode'ları). 40 = Enter (kart okuma sonu).
const HID_KEYMAP = {
  30: '1', 31: '2', 32: '3', 33: '4', 34: '5',
  35: '6', 36: '7', 37: '8', 38: '9', 39: '0'
};
const HID_ENTER_CODE = 40;

// Sürüm TEK KAYNAKTAN geliyor: package.json.
//
// Önce burada elle yazılı bir sabit vardı ve her sürümde iki dosyayı ayrı ayrı
// güncellemek gerekiyordu. Onlarca sürüm sonra kaçınılmaz olan oldu: ikisi
// birbirinden ayrıldı, arayüz eski sürümü gösterdi. İnsanın elle senkron
// tutması gereken her şey er geç kayar - o yüzden artık kaymasi mümkün değil.
//
// require() önbelleklendiği için bu değer, modülün YÜKLENDİĞİ andaki sürümü
// taşıyor. Yani hâlâ "bellekte çalışan kod" sürümü: Volumio eski index.js'i
// require önbelleğinden çalıştırmaya devam ederse bu değer eski kalır, diskteki
// package.json ise yeni olur. Teşhis yeteneğini kaybetmiyoruz - aşağıdaki
// getDiskVersion() diskten TAZE okuyor, ikisi farklıysa arayüz uyarıyor.
const PLUGIN_CODE_VERSION = (function () {
  try {
    return require('./package.json').version || 'bilinmiyor';
  } catch (err) {
    return 'bilinmiyor';
  }
})();

// Diskteki güncel sürüm (önbelleksiz). PLUGIN_CODE_VERSION'dan farklıysa
// Volumio eski kodu çalıştırıyor demektir; çözümü: sudo systemctl restart volumio
function getDiskVersion() {
  try {
    const p = path.join(__dirname, 'package.json');
    return (JSON.parse(fs.readFileSync(p, 'utf8')) || {}).version || null;
  } catch (err) {
    return null;
  }
}

module.exports = ControllerMecazicards;

function ControllerMecazicards(context) {
  const self = this;
  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;
}

// -------------------- Volumio yaşam döngüsü --------------------

ControllerMecazicards.prototype.onVolumioStart = function () {
  const self = this;
  const configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
  return libQ.resolve();
};

ControllerMecazicards.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerMecazicards.prototype.onStart = function () {
  const self = this;
  const defer = libQ.defer();

  self.readingBuffer = '';
  self.hidStream = null;
  self.hidRetryTimeout = null;
  self.lastCardId = '';
  self.lastUnmatchedCardId = '';
  self.grabProcess = null;
  self.grabRetryTimeout = null;
  self.grabStatus = 'başlatılıyor…';

  // Her şeyden ÖNCE: güncelleme eşleştirmeleri sildiyse geri yükle.
  self.restoreMappingsIfWiped();

  self.startCardReader();
  self.startInputGrab();
  self.startWebServer();
  self.logger.info('[mecazicards_for_spotify] Eklenti başlatıldı.');

  defer.resolve();
  return defer.promise;
};

ControllerMecazicards.prototype.onStop = function () {
  const self = this;
  const defer = libQ.defer();

  self.stopCardReader();
  self.stopInputGrab();
  self.stopWebServer();
  self.logger.info('[mecazicards_for_spotify] Eklenti durduruldu.');

  defer.resolve();
  return defer.promise;
};

ControllerMecazicards.prototype.onRestart = function () {
  // Ekstra bir işlem gerekmiyor; Volumio onStop + onStart çağıracak.
};

// -------------------- Eşleştirme (mapping) yardımcıları --------------------

ControllerMecazicards.prototype.getMappings = function () {
  const self = this;
  try {
    const raw = self.config.get('mappings');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    self.logger.error('[mecazicards_for_spotify] mappings okunamadı: ' + err.message);
    return {};
  }
};

ControllerMecazicards.prototype.persistMappings = function (mappings) {
  const self = this;
  self.config.set('mappings', JSON.stringify(mappings));
  self.saveUserState();
};

// -------------------- Karta elle isim / görsel --------------------
//
// NEDEN GEREKLİ: Spotify'ın kişiselleştirilmiş listeleri (daylist, Daily Mix,
// Blend, sanatçı radyoları) üçüncü parti uygulamalara kapalı. Üç kademeyi de
// denedik: /v1/playlists 404, oEmbed 404, kullanıcı kitaplığı da onları
// içermiyor ("Made For You" ayrı bir yerde yaşıyor, çalma listesi kitaplığında
// değil). Aynı şey Spotify'ın emekliye ayırdığı listeler için de geçerli.
//
// Bu yüzden son çare API değil KULLANICI: karta kendi ismini ve görselini
// verebiliyorsun. Spotify yarın bu uçları büsbütün kapatsa da bu yol çalışır.
//
// Görseller config'in yanına yazılıyor (paketin içine DEĞİL), böylece eklenti
// güncellemesi onları silmiyor - kart eşleştirmelerinde öğrendiğimiz ders.
const CUSTOM_IMAGE_DIR = 'card-images';
const MAX_CUSTOM_IMAGE_BYTES = 3 * 1024 * 1024;
// base64 payı + JSON zarfı için pay bırakıyoruz.
const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

ControllerMecazicards.prototype.getCustomInfo = function () {
  const self = this;
  try {
    const raw = self.config.get('custom_info');
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    return {};
  }
};

ControllerMecazicards.prototype.persistCustomInfo = function (info) {
  this.config.set('custom_info', JSON.stringify(info));
  this.saveUserState();
};

ControllerMecazicards.prototype.getCustomImageDir = function () {
  const self = this;
  const cfgFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
  const dir = path.join(path.dirname(cfgFile), CUSTOM_IMAGE_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// cardId dosya adına giriyor - sadece güvenli karakterlere izin veriyoruz ki
// "../../" gibi bir kart kimliği dizin dışına yazamasın.
function safeCardId(cardId) {
  const id = String(cardId || '').trim();
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new Error('Geçersiz kart ID: ' + cardId);
  return id;
}

ControllerMecazicards.prototype.saveCustomCardInfo = function (cardId, name, imageDataUrl, clearImage) {
  const self = this;
  const id = safeCardId(cardId);
  const info = self.getCustomInfo();
  const entry = Object.assign({}, info[id] || {});

  // null/undefined = "isme dokunma" (ör. sadece görsel yükleniyor)
  // ''             = "ismi sil, Spotify'dan geleni kullan"
  if (name !== null && name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed) entry.name = trimmed.slice(0, 200);
    else delete entry.name;
  }

  if (clearImage) {
    if (entry.image) {
      try { fs.unlinkSync(path.join(self.getCustomImageDir(), entry.image)); } catch (e) { /* yoksa sorun değil */ }
    }
    delete entry.image;
  } else if (imageDataUrl) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(imageDataUrl).trim());
    if (!m) throw new Error('Görsel biçimi tanınmadı (PNG/JPEG/WebP olmalı).');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('Görsel boş.');
    if (buf.length > MAX_CUSTOM_IMAGE_BYTES) {
      throw new Error('Görsel çok büyük (' + Math.round(buf.length / 1024) + ' KB).');
    }
    const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
    const fileName = id + '.' + ext;
    fs.writeFileSync(path.join(self.getCustomImageDir(), fileName), buf);
    // Uzantı değiştiyse eskisini temizle
    if (entry.image && entry.image !== fileName) {
      try { fs.unlinkSync(path.join(self.getCustomImageDir(), entry.image)); } catch (e) { /* önemsiz */ }
    }
    entry.image = fileName;
    entry.imageAt = Date.now();
  }

  if (!entry.name && !entry.image) delete info[id];
  else info[id] = entry;

  self.persistCustomInfo(info);
  return info[id] || null;
};

// -------------------- Eşleştirmelerin can yeleği --------------------
//
// NEDEN VAR: Volumio, eklenti güncellemesinde çalışma config'ini paketin içindeki
// config.json ile EZİYOR. v3.12.0'da paketteki şablonu boşaltmıştım (kişisel kart
// listesi herkese açık depoda durmasın diye) ve güncelleme 148 kartı sildi.
//
// Yanlış olan varsayım şuydu: "Volumio canlı config'i korur." Bunu, şablonunda
// zaten aynı kartlar bulunan sürümleri kurarak 'doğruladığımı' sanmıştım - oysa o
// testler "korunuyor" ile "aynı veriyle eziliyor" arasını ayırt edemiyordu.
//
// Artık eşleştirmeler her değiştiğinde config'in YANINA ayrı bir kopya yazılıyor.
// Bu dosya paketin içinde olmadığı için güncelleme onu ezemiyor. Açılışta config
// boş ama kopya doluysa, eklenti kendi kendine geri yüklüyor.
// KORUMA SADECE KARTLAR İÇİN DEĞİL. Şablon boş olduğu için güncelleme,
// kullanıcının HER ayarını siliyordu: Spotify kimlik bilgileri, yetkilendirme,
// çekilmiş isimler, çalma istatistiği, elle verilen isim/kapaklar. Kullanıcının
// her güncellemeden sonra "API'yi girip hesabı yeniden bağlaması" bundandı.
//
// spotify_oauth_state bilerek DIŞARIDA: geçici bir CSRF değeri, taşınması yanlış.
const MAPPINGS_SAFETY_FILE = 'kullanici-ayarlari-yedegi.json';
const LEGACY_SAFETY_FILE = 'mappings-guvenlik-kopyasi.json';
const USER_STATE_KEYS = [
  'mappings', 'resolved_names', 'play_stats', 'custom_info',
  'spotify_client_id', 'spotify_client_secret', 'spotify_refresh_token',
  'spotify_connect_device_name', 'playback_mode', 'gallery_sort',
  'last_played_card_id', 'hid_device_path', 'input_event_device_path',
  'web_ui_port'
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isEmptyConfigValue(v) {
  if (v === null || v === undefined) return true;
  const s = String(v).trim();
  return s === '' || s === '{}';
}

// Yedeğin ASIL yeri eklentinin ayar klasörü DEĞİL.
//
// Kullanıcı güncellemek için eklentiyi önce kaldırıp sonra kuruyordu; Volumio
// kaldırırken ayar klasörünün tamamını siliyor ve yedek de onunla gidiyordu.
// Kaldırma işleminde ölen bir yedek, yedek değildir.
//
// Bu yüzden asıl kopya /data altında, eklentiden bağımsız bir klasörde.
// Orası kalıcı bölüm: eklenti kaldırılsa da hayatta kalıyor.
const DURABLE_BACKUP_DIR = '/data/mecazicards-yedek';

ControllerMecazicards.prototype.getDurableBackupPath = function () {
  const self = this;
  try {
    if (!fs.existsSync(DURABLE_BACKUP_DIR)) {
      fs.mkdirSync(DURABLE_BACKUP_DIR, { recursive: true, mode: 0o700 });
    }
    // Klasör root'a ait oluşturulmuş olabilir (install.sh root çalışıyor). O
    // hâlde buraya yazamayız ve koruma SESSİZCE devre dışı kalır - cihazda tam
    // olarak bu yaşandı. Yazma iznini fiilen sınayıp yoksa yüksek sesle
    // söylüyoruz; sessiz başarısızlık bu projede en pahalıya patlayan hata türü.
    try {
      fs.accessSync(DURABLE_BACKUP_DIR, fs.constants.W_OK);
    } catch (err) {
      if (!self._durableWarned) {
        self._durableWarned = true;
        self.logger.error('[mecazicards_for_spotify] Kalıcı yedek klasörüne YAZILAMIYOR: ' +
          DURABLE_BACKUP_DIR + ' — düzeltmek için: sudo chown -R volumio:volumio ' +
          DURABLE_BACKUP_DIR);
      }
      return null;
    }
    return path.join(DURABLE_BACKUP_DIR, MAPPINGS_SAFETY_FILE);
  } catch (err) {
    return null;
  }
};

// Okuma sırası: önce kalıcı yer, sonra ayar klasörü, sonra v3.13.0'ın eski
// biçimi. Hangisi bulunursa oradan devam ediyoruz.
ControllerMecazicards.prototype.getSafetyCandidates = function () {
  const self = this;
  return [self.getDurableBackupPath(), self.getSafetyCopyPath(), self.getSafetyCopyPath(true)]
    .filter(Boolean);
};

ControllerMecazicards.prototype.getSafetyCopyPath = function (legacy) {
  const self = this;
  try {
    const cfgFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
    return path.join(path.dirname(cfgFile), legacy ? LEGACY_SAFETY_FILE : MAPPINGS_SAFETY_FILE);
  } catch (err) {
    return null;
  }
};

// Kullanıcıya ait tüm ayarları config'in yanına yaz.
ControllerMecazicards.prototype.saveUserState = function () {
  const self = this;
  try {
    const hedefler = [self.getDurableBackupPath(), self.getSafetyCopyPath()].filter(Boolean);
    if (!hedefler.length) return;

    const values = {};
    USER_STATE_KEYS.forEach((k) => {
      const v = self.config.get(k);
      if (!isEmptyConfigValue(v)) values[k] = v;
    });

    // Kartlar boşsa yazma: bu büyük ihtimalle ezilmiş bir config demek ve
    // dolu bir yedeği boşla değiştirmek, korumaya çalıştığımız kaybın kendisi.
    //
    // "Boş mu" kontrolü ham metne bakmak DEĞİL, gerçekten ayrıştırmak zorunda:
    // v-conf config.json'ı atomik yazmıyor, elektrik kesilirse dosya yarım
    // kalabiliyor (ör. '{"0012":"spotify:play'). Böyle bir metin "boş" değil ama
    // içi de yok - ham metne baksaydık bozuk veriyi sağlam yedeğin üstüne
    // yazardık ve 148 kartın son sağlam kopyasını kendi elimizle silerdik.
    let kartSayisi = 0;
    try {
      const m = JSON.parse(values.mappings || '{}');
      kartSayisi = (m && typeof m === 'object' && !Array.isArray(m)) ? Object.keys(m).length : 0;
    } catch (err) {
      self.logger.warn('[mecazicards_for_spotify] config bozuk görünüyor, ' +
        'ayar yedeğine DOKUNULMADI (mevcut yedek korunuyor).');
      return;
    }
    if (!kartSayisi) return;

    const govde = JSON.stringify({
      savedAt: new Date().toISOString(),
      pluginVersion: PLUGIN_CODE_VERSION,
      values: values
    }, null, 2);

    // Atomik yazma: doğrudan üstüne yazmak, yazma sırasında elektrik kesilirse
    // yedeği yarım bırakır - tam da onu lazım edecek anda kullanılamaz olur.
    // İki yere birden yazıyoruz; asıl olan /data altındaki kalıcı kopya, ayar
    // klasöründeki ise eklenti dururken elde kolay bulunsun diye.
    hedefler.forEach((file) => {
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, govde, { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch (e) { /* önemsiz */ }
        fs.renameSync(tmp, file);
      } catch (err) {
        self.logger.warn('[mecazicards_for_spotify] Yedek yazılamadı (' + file + '): ' + err.message);
      }
    });
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] Ayar yedeği yazılamadı: ' + err.message);
  }
};

// Geriye dönük uyumluluk: v3.13.0 yalnızca eşleştirmeleri saklıyordu.
ControllerMecazicards.prototype.readSafetyFile = function () {
  const self = this;
  // Sıra: kalıcı /data kopyası -> ayar klasörü -> v3.13.0'ın eski biçimi.
  // Eklenti kaldırılıp yeniden kurulduğunda yalnızca ilki hayatta kalıyor.
  const adaylar = self.getSafetyCandidates();
  for (let i = 0; i < adaylar.length; i++) {
    const yol = adaylar[i];
    try {
      if (!fs.existsSync(yol)) continue;
      const d = JSON.parse(fs.readFileSync(yol, 'utf8'));
      if (d && d.values && !isEmptyConfigValue(d.values.mappings)) {
        self.logger.info('[mecazicards_for_spotify] Ayar yedeği bulundu: ' + yol);
        return d;
      }
      // v3.13.0 biçimi
      if (d && d.mappings && Object.keys(d.mappings).length) {
        self.logger.info('[mecazicards_for_spotify] Eski biçim yedek bulundu: ' + yol);
        return { savedAt: d.savedAt, values: { mappings: JSON.stringify(d.mappings) } };
      }
    } catch (err) {
      self.logger.warn('[mecazicards_for_spotify] Yedek okunamadı (' + yol + '): ' + err.message);
    }
  }
  return null;
};

// Açılışta çağrılıyor. Güncelleme ayarları sildiyse geri yükler.
// Mevcut (dolu) değerlere ASLA dokunmaz - kullanıcının verisi her zaman üstün.
ControllerMecazicards.prototype.restoreMappingsIfWiped = function () {
  const self = this;
  try {
    const saved = self.readSafetyFile();
    if (!saved || !saved.values) { self.saveUserState(); return; }

    const cardsWiped = isEmptyConfigValue(self.config.get('mappings')) &&
                       !isEmptyConfigValue(saved.values.mappings);

    const geri = [];
    USER_STATE_KEYS.forEach((k) => {
      const yedek = saved.values[k];
      if (isEmptyConfigValue(yedek)) return;
      const simdi = self.config.get(k);
      // Kartlar silinmişse config baştan yazılmış demektir: varsayılana dönmüş
      // ayarları da (playback_mode, gallery_sort gibi) geri alıyoruz. Aksi
      // hâlde yalnızca BOŞ olanları dolduruyoruz - dolu bir değeri ezmiyoruz.
      if (isEmptyConfigValue(simdi) || cardsWiped) {
        if (String(simdi) !== String(yedek)) {
          self.config.set(k, yedek);
          geri.push(k);
        }
      }
    });

    if (geri.length) {
      const kartSayisi = (() => {
        try { return Object.keys(JSON.parse(saved.values.mappings || '{}')).length; }
        catch (e) { return 0; }
      })();
      self.logger.warn('[mecazicards_for_spotify] Güncelleme ayarları silmiş, ' +
        'yedekten geri yüklendi (' + geri.join(', ') + ') — kayıt: ' +
        (saved.savedAt || 'bilinmiyor'));
      self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify',
        (cardsWiped ? kartSayisi + ' kart ve ' : '') + 'ayarların güncelleme sonrası ' +
        'yedekten geri yüklendi.');
    }

    self.saveUserState();
  } catch (err) {
    self.logger.error('[mecazicards_for_spotify] Ayar yedeği okunamadı: ' + err.message);
  }
};

// -------------------- Spotify Web API (sadece isim gösterimi için) --------------------
// NOT: Bu, playback ile hiç ilgili değil - playback Volumio'nun kendi Spotify
// eklentisi (commandRouter.replaceAndPlay) üzerinden aynen devam ediyor. Bu
// bölüm sadece ayarlar sayfasındaki listede "spotify:playlist:37i9..." yerine
// gerçek playlist/sanatçı ismini gösterebilmek için client-credentials akışıyla
// Spotify'ın herkese açık katalog verisini okuyor.

function parseSpotifyUri(uri) {
  const parts = String(uri).split(':');
  if (parts.length >= 3 && parts[0] === 'spotify') {
    return { type: parts[1], id: parts[parts.length - 1] };
  }
  return null;
}

ControllerMecazicards.prototype.getResolvedNames = function () {
  const self = this;
  try {
    const raw = self.config.get('resolved_names');
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
};

ControllerMecazicards.prototype.persistResolvedNames = function (names) {
  const self = this;
  self.config.set('resolved_names', JSON.stringify(names));
  this.saveUserState();
};

// -------------------- Çalma istatistiği --------------------
// Kart başına dört sayı tutuyoruz:
//   count    - ham çalma sayısı (rozette gösterilen)
//   last     - son çalma zamanı (ms)
//   score    - ERİYEN puan: her çalma +1, zamanla yarılanıyor
//   scoreAt  - puanın en son güncellendiği an
//
// Neden eriyen puan? Düz "en çok çalınan" muhafazakâr: Ocak'ta 50 kez çalınan
// bir kart, bir daha hiç çalınmasa da aylarca tepede kalır ve yeni kartlar asla
// tırmanamaz. Düz "son çalınan" ise fazla oynak - elindeki kartı zaten
// biliyorsun, en üstte görmek bilgi vermiyor. Erime ikisinin ortası:
// "son zamanlarda en çok çalınan".
//
// Yarı ömür 30 gün. Her gün çalınan bir kart ~44 puanda dengeleniyor; 6 ay önce
// 50 kez çalınıp bırakılan kart 50 × 0.5^6 ≈ 0.8'e düşüyor, yani geçen hafta iki
// kez çalınan kartın altına iniyor.
//
// Sadece iki sayı sakladığımız için (puan + zaman damgası) her çalmanın
// geçmişini tutmaya gerek yok; erime tek satırlık bir formül.
const SCORE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// Galeride seçilebilen sıralamalar. 'score' varsayılan: son zamanlarda en çok
// çalınan. Veri dördü için de tutulduğundan seçim sadece bir görünüm tercihi.
const GALLERY_SORTS = ['score', 'last', 'name', 'card'];
const GALLERY_SORT_DEFAULT = 'score';

function decayScore(score, scoreAt, now) {
  const s = Number(score) || 0;
  if (s <= 0) return 0;

  const at = Number(scoreAt) || 0;
  // Zaman damgası yoksa (bozuk ya da eksik kayıt) puanı OLDUĞU GİBİ döndürüyoruz.
  // Ne kadar eskidiğini bilmiyoruz; bilmediğimiz için veriyi silmek yanlış olur.
  // Bir sonraki çalmada damga yerine oturur ve erime normal işlemeye başlar.
  if (!at) return s;

  const elapsed = now - at;
  // Saat geri gitmişse (NTP düzeltmesi, elle saat ayarı) puanı şişirmiyoruz.
  if (elapsed <= 0) return s;

  return s * Math.pow(0.5, elapsed / SCORE_HALF_LIFE_MS);
}

// -------------------- Yedekleme / geri yükleme --------------------
// Kart eşleştirmeleri bu projenin YERİNE KONAMAZ tek parçası. Kod her zaman
// yeniden yazılır; 148 kartı tek tek okutup yeniden eşlemek ise saatler alır.
// Hepsi tek bir SD kartta duruyor ve Raspberry Pi'lerde en sık görülen arıza
// SD kartın ölmesi. Bu yüzden dışa aktarma/geri yükleme tali bir özellik değil.
//
// KİMLİK BİLGİLERİ BİLEREK DIŞARIDA BIRAKILDI. Yedek dosyası bilgisayara
// kopyalanacak, e-postayla gönderilecek, buluta atılacak bir dosya; içine
// client secret ve refresh token koymak onu bir sızıntı riskine çevirir.
// Kaybolduklarında yeniden elde etmek de kolay: secret Spotify panelinden
// kopyalanır, token bir kez yetkilendirmeyle yenilenir. Eşleştirmelerin ise
// başka kopyası yok - korunması gereken onlar.
const BACKUP_FORMAT = 'mecazicards-backup';
const BACKUP_FORMAT_VERSION = 1;

ControllerMecazicards.prototype.buildBackup = function () {
  const self = this;
  const mappings = self.getMappings();
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    pluginVersion: PLUGIN_CODE_VERSION,
    cardCount: Object.keys(mappings).length,
    note: 'Kimlik bilgileri (client secret / refresh token) güvenlik gerekçesiyle bu dosyaya DAHİL EDİLMEZ.',
    mappings: mappings,
    resolvedNames: self.getResolvedNames(),
    playStats: self.getPlayStats(),
    // Elle verilen isimler ve kapaklar da yedeğe giriyor. Bunlar Spotify'dan
    // yeniden çekilemez - kişisel listeler için TEK kaynak kullanıcının kendisi.
    // Yedek "SD kart ölürse kurtarır" diye duruyorsa, bunları dışarıda bırakmak
    // onu yarım bir sigortaya çevirirdi.
    customInfo: self.getCustomInfo(),
    customImages: self.collectCustomImages()
  };
};

// Kapak görsellerini data-URL olarak topla. Yedek dosyası tek parça olsun diye
// gömüyoruz; ama sınırsız değil - çok büyürse isimleri alıp görselleri atlıyoruz
// ve bunu yedeğin içine yazıyoruz ki kullanıcı neyin eksik olduğunu bilsin.
const BACKUP_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

ControllerMecazicards.prototype.collectCustomImages = function () {
  const self = this;
  const out = {};
  try {
    const info = self.getCustomInfo();
    const dir = self.getCustomImageDir();
    let toplam = 0;
    Object.keys(info).forEach((id) => {
      const dosya = info[id] && info[id].image;
      if (!dosya) return;
      try {
        const tam = path.join(dir, dosya);
        const st = fs.statSync(tam);
        if (toplam + st.size > BACKUP_IMAGE_BUDGET_BYTES) return;
        const ext = path.extname(dosya).toLowerCase().replace('.', '');
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        out[id] = 'data:' + mime + ';base64,' + fs.readFileSync(tam).toString('base64');
        toplam += st.size;
      } catch (err) { /* tek bir görsel okunamadıysa yedeği durdurmaya değmez */ }
    });
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] Kapaklar yedeğe alınamadı: ' + err.message);
  }
  return out;
};

// Yedek dosyasını sıkı doğrula. Bozuk bir dosyayı geri yüklemek 148 kartlık
// listeyi bozabilir - bu yüzden şüpheli her şeyi reddedip sebebini söylüyoruz.
ControllerMecazicards.prototype.validateBackup = function (data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Dosya bir yedek dosyası gibi görünmüyor (JSON nesnesi değil).');
  }
  if (data.format !== BACKUP_FORMAT) {
    throw new Error('Bu bir mecazicards yedek dosyası değil (format: ' + (data.format || 'yok') + ').');
  }
  if (Number(data.formatVersion) > BACKUP_FORMAT_VERSION) {
    throw new Error('Yedek dosyası daha yeni bir sürümden (v' + data.formatVersion +
      '). Önce eklentiyi güncelle.');
  }
  const m = data.mappings;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('Yedekte eşleştirme listesi yok ya da bozuk.');
  }

  const clean = {};
  const bad = [];
  Object.keys(m).forEach((cardId) => {
    const uri = m[cardId];
    const idOk = typeof cardId === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(cardId);
    const uriOk = typeof uri === 'string' && /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(uri.trim());
    if (idOk && uriOk) clean[cardId] = uri.trim();
    else bad.push(cardId);
  });

  if (!Object.keys(clean).length) {
    throw new Error('Yedekte geçerli tek bir eşleştirme bile bulunamadı.');
  }
  return { mappings: clean, skipped: bad };
};

// Geri yüklemeden ÖNCE mevcut durumu diske yaz. Kötü bir geri yükleme geri
// alınabilir olmalı - bu gece çalışan bir sistemi bozmanın ne demek olduğunu
// gördük.
ControllerMecazicards.prototype.snapshotBeforeRestore = function () {
  const self = this;
  try {
    const dir = '/tmp';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, 'mecazicards-geri-yukleme-oncesi-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(self.buildBackup(), null, 2), 'utf8');
    self.logger.info('[mecazicards_for_spotify] Geri yükleme öncesi yedek: ' + file);
    return file;
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] Geri yükleme öncesi yedek alınamadı: ' + err.message);
    return null;
  }
};

ControllerMecazicards.prototype.applyBackup = function (data, mode) {
  const self = this;
  const parsed = self.validateBackup(data);
  const snapshot = self.snapshotBeforeRestore();

  const before = self.getMappings();
  const beforeCount = Object.keys(before).length;

  // 'replace' = eşleştirmeler birebir yedektekiler olur.
  // 'merge'   = yedektekiler eklenir/günceller, yedekte olmayan kartlar KALIR.
  const next = (mode === 'replace') ? {} : Object.assign({}, before);
  Object.keys(parsed.mappings).forEach((id) => { next[id] = parsed.mappings[id]; });
  self.persistMappings(next);

  // İsimler ve istatistik varsa onları da al, ama YALNIZCA birleştirerek -
  // eldeki taze isimleri eski bir yedekle geri götürmenin anlamı yok.
  let names = 0;
  if (data.resolvedNames && typeof data.resolvedNames === 'object' && !Array.isArray(data.resolvedNames)) {
    const merged = Object.assign({}, data.resolvedNames, self.getResolvedNames());
    self.persistResolvedNames(merged);
    names = Object.keys(data.resolvedNames).length;
  }
  let stats = 0;
  if (data.playStats && typeof data.playStats === 'object' && !Array.isArray(data.playStats)) {
    const cur = self.getPlayStats();
    const merged = Object.assign({}, data.playStats);
    // Aynı kart iki yerde varsa ÇOK ÇALINMIŞ olanı koru - istatistik kaybetmeyelim.
    Object.keys(cur).forEach((id) => {
      const a = merged[id], b = cur[id];
      merged[id] = (a && Number(a.count) > Number(b.count || 0)) ? a : b;
    });
    self.persistPlayStats(merged);
    stats = Object.keys(data.playStats).length;
  }

  // Elle verilen isim ve kapakları geri yükle. Mevcut olanı EZMİYORUZ:
  // eldeki taze bilgi eski bir yedekten daha değerlidir.
  let ozel = 0;
  if (data.customInfo && typeof data.customInfo === 'object' && !Array.isArray(data.customInfo)) {
    const cur = self.getCustomInfo();
    Object.keys(data.customInfo).forEach((id) => {
      let temizId;
      try { temizId = safeCardId(id); } catch (err) { return; }
      if (cur[temizId]) return;                       // eldeki üstün
      const gelen = data.customInfo[id] || {};
      const kayit = {};
      if (typeof gelen.name === 'string' && gelen.name.trim()) {
        kayit.name = gelen.name.trim().slice(0, 200);
      }
      const dataUrl = data.customImages && data.customImages[id];
      if (dataUrl) {
        try {
          const yazilan = self.saveCustomCardInfo(temizId, kayit.name || null, dataUrl, false);
          if (yazilan) { ozel++; return; }
        } catch (err) {
          self.logger.warn('[mecazicards_for_spotify] Kapak geri yüklenemedi (' +
            temizId + '): ' + err.message);
        }
      }
      if (kayit.name) {
        try { self.saveCustomCardInfo(temizId, kayit.name, null, false); ozel++; }
        catch (err) { /* geçersiz kayıt, atla */ }
      }
    });
  }

  const afterCount = Object.keys(next).length;
  self.logger.info('[mecazicards_for_spotify] Geri yükleme (' + mode + '): ' +
    beforeCount + ' -> ' + afterCount + ' kart, ' + ozel + ' özel isim/kapak');

  return {
    mode: mode,
    before: beforeCount,
    after: afterCount,
    restored: Object.keys(parsed.mappings).length,
    skipped: parsed.skipped,
    names: names,
    stats: stats,
    custom: ozel,
    snapshot: snapshot
  };
};

ControllerMecazicards.prototype.getPlayStats = function () {
  const self = this;
  try {
    const raw = self.config.get('play_stats');
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    return {};
  }
};

ControllerMecazicards.prototype.persistPlayStats = function (stats) {
  const self = this;
  self.config.set('play_stats', JSON.stringify(stats));
  this.saveUserState();
};

ControllerMecazicards.prototype.recordCardPlay = function (cardId) {
  const self = this;
  try {
    const now = Date.now();
    const stats = self.getPlayStats();
    const prev = stats[cardId] || {};
    stats[cardId] = {
      count: (Number(prev.count) || 0) + 1,
      last: now,
      score: decayScore(Number(prev.score) || 0, Number(prev.scoreAt) || 0, now) + 1,
      scoreAt: now
    };
    self.persistPlayStats(stats);
  } catch (err) {
    // İstatistik tutulamazsa müzik yine çalsın - bu tali bir özellik.
    self.logger.warn('[mecazicards_for_spotify] Çalma istatistiği yazılamadı: ' + err.message);
  }
};

ControllerMecazicards.prototype.getSpotifyAccessToken = function () {
  const self = this;
  const defer = libQ.defer();

  if (self.spotifyToken && Date.now() < (self.spotifyTokenExpiry || 0) - 30000) {
    defer.resolve(self.spotifyToken);
    return defer.promise;
  }

  const clientId = (self.config.get('spotify_client_id') || '').trim();
  const clientSecret = (self.config.get('spotify_client_secret') || '').trim();

  if (!clientId || !clientSecret) {
    defer.reject(new Error('Spotify Client ID/Secret girilmemiş.'));
    return defer.promise;
  }

  const postData = querystring.stringify({ grant_type: 'client_credentials' });
  const authHeader = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');

  const req = https.request({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 10000
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (res.statusCode === 200 && json.access_token) {
          self.spotifyToken = json.access_token;
          self.spotifyTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
          defer.resolve(self.spotifyToken);
        } else {
          defer.reject(new Error('Spotify token alınamadı (' + res.statusCode + '): ' + body));
        }
      } catch (err) {
        defer.reject(err);
      }
    });
  });

  req.on('error', (err) => defer.reject(err));
  req.on('timeout', () => { req.destroy(); defer.reject(new Error('Spotify token isteği zaman aşımına uğradı.')); });
  req.write(postData);
  req.end();

  return defer.promise;
};

ControllerMecazicards.prototype.spotifyApiGet = function (urlPath) {
  const self = this;
  const defer = libQ.defer();

  self.getSpotifyAccessToken().then((token) => {
    const req = https.request({
      hostname: 'api.spotify.com',
      path: urlPath,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            defer.resolve(json);
          } else {
            defer.reject(new Error('Spotify API hatası (' + res.statusCode + '): ' +
              (json.error && json.error.message ? json.error.message : body)));
          }
        } catch (err) {
          defer.reject(err);
        }
      });
    });
    req.on('error', (err) => defer.reject(err));
    req.on('timeout', () => { req.destroy(); defer.reject(new Error('Spotify API isteği zaman aşımına uğradı.')); });
    req.end();
  }).fail((err) => defer.reject(err));

  return defer.promise;
};

// -------------------- oEmbed yedeği (editoryal playlist'ler için) --------------------
// Spotify, Kasım 2024'te Web API'de büyük bir kısıtlamaya gitti: kendi
// hazırladığı "editoryal" ve algoritmik çalma listeleri (ID'si 37i9dQZF1... ile
// başlayanların hemen hepsi - Türkçe Rock, Discover Weekly, Top 50 vb.) artık
// /v1/playlists/{id} ucundan 404 dönüyor. Bu, uygulamanın izniyle veya
// token'ıyla ilgili değil; Spotify o verileri üçüncü taraf uygulamalara
// tamamen kapattı. Senin kartlarının çoğu bu tip listeler olduğu için isimleri
// boş kalıyordu.
//
// Çözüm: Spotify'ın herkese açık oEmbed ucu (open.spotify.com/oembed) bu
// listeler için hâlâ başlık ve kapak görseli döndürüyor ve hiçbir kimlik
// doğrulaması istemiyor. Web API başarısız olursa buna düşüyoruz.

function httpsGetJson(urlStr, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const parsedUrl = nodeUrl.parse(urlStr);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      method: 'GET',
      headers: { 'User-Agent': 'mecazicards-for-spotify', Accept: 'application/json' },
      timeout: 10000
    }, (res) => {
      // Yönlendirmeleri elle takip et (Node bunu kendiliğinden yapmıyor).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Çok fazla yönlendirme.'));
        const next = nodeUrl.resolve(urlStr, res.headers.location);
        return resolve(httpsGetJson(next, redirectsLeft - 1));
      }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('Geçersiz JSON yanıt.')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımına uğradı.')); });
    req.end();
  });
}

// HTML varlıklarını çöz. oEmbed başlıkları "&amp;" gibi kaçışlar içerebiliyor;
// Türkçe/aksanlı harfler de "&uuml;" ya da "&#252;" biçiminde gelebiliyor.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  ccedil: 'ç', Ccedil: 'Ç', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', aring: 'å',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û',
  ntilde: 'ñ', Ntilde: 'Ñ', yacute: 'ý', yuml: 'ÿ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Aring: 'Å',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°',
  copy: '©', reg: '®', trade: '™', eur: '€', pound: '£'
};

function decodeHtmlEntities(text) {
  return String(text)
    // Onaltılık: &#x1F600;
    .replace(/&#[xX]([0-9A-Fa-f]+);/g, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; }
    })
    // Ondalık: &#252;
    .replace(/&#(\d+);/g, (m, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; }
    })
    // İsimli: &uuml; &amp; ...  ("&amp;" en sona kalsın diye tek geçişte yapıyoruz.
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m);
}

ControllerMecazicards.prototype.resolveViaOembed = function (uri) {
  const parsed = parseSpotifyUri(uri);
  if (!parsed) return Promise.reject(new Error('Geçersiz Spotify URI: ' + uri));

  const pageUrl = 'https://open.spotify.com/' + parsed.type + '/' + parsed.id;
  const oembedUrl = 'https://open.spotify.com/oembed?url=' + encodeURIComponent(pageUrl);

  return httpsGetJson(oembedUrl, 3).then((json) => {
    if (!json || !json.title) throw new Error('oEmbed başlık döndürmedi.');
    return {
      name: decodeHtmlEntities(json.title),
      image: json.thumbnail_url || null,
      type: parsed.type,
      source: 'oembed'
    };
  });
};

// Isim + kapak gorseli birlikte cozer (kart galerisi icin gorsel de lazim).
// Once resmi Web API, olmazsa oEmbed yedegi denenir.
// Kullanıcının kendi kitaplığındaki listeleri (takip ettikleri dâhil) tek seferde
// çekip id -> {name, image} haritası kurar. 10 dakika önbellekli: kitaplık sık
// değişmiyor ve 148 kartlık bir yenilemede tekrar tekrar çekmenin anlamı yok.
//
// Bu çağrı `playlist-read-private` + `playlist-read-collaborative` izinlerini
// gerektiriyor. İzin yoksa Spotify 404 DEĞİL 403 döner - yani "liste yok" değil,
// "yetkin yok". O durumda kullanıcıya yetkilendirmeyi yenilemesini söylüyoruz.
const LIBRARY_CACHE_MS = 10 * 60 * 1000;
const LIBRARY_ERROR_CACHE_MS = 60 * 1000;   // başarısızlığı da hatırla, bkz. aşağısı
const LIBRARY_DEADLINE_MS = 25 * 1000;      // tüm kitaplık taraması için üst sınır
const LIBRARY_MAX_PAGES = 20;   // 20 x 50 = 1000 liste; makul bir üst sınır

ControllerMecazicards.prototype.clearLibraryCache = function (reason) {
  const self = this;
  self._libraryCache = null;
  self._libraryCacheAt = 0;
  self._libraryError = null;
  self._libraryErrorAt = 0;
  if (reason) {
    self.logger.info('[mecazicards_for_spotify] Kitaplık önbelleği temizlendi: ' + reason);
  }
};

ControllerMecazicards.prototype.getUserPlaylistLibrary = function () {
  const self = this;

  if (self._libraryCache && Date.now() - self._libraryCacheAt < LIBRARY_CACHE_MS) {
    return Promise.resolve(self._libraryCache);
  }

  // BAŞARISIZLIĞI DA ÖNBELLEĞE AL.
  //
  // Bu unutulunca şu oluyordu: ismi çözülemeyen HER kart, kütüphaneyi baştan
  // (sayfa sayfa) çekmeye kalkıyordu. Yetkilendirme yenilenmemişse 148 kartın
  // her biri için ayrı ayrı 403 alınıyor, işlem dakikalarca sürüyor ve tarayıcı
  // "Failed to fetch" ile pes ediyordu. Kütüphane çağrısı bir kez başarısızsa
  // aynı yenileme turunda tekrar denemenin hiçbir faydası yok - sebep kart
  // bazlı değil, hesap bazlı.
  if (self._libraryError && Date.now() - self._libraryErrorAt < LIBRARY_ERROR_CACHE_MS) {
    return Promise.reject(self._libraryError);
  }

  if (self._libraryInFlight) return self._libraryInFlight;

  if (!(self.config.get('spotify_refresh_token') || '').trim()) {
    const err = new Error('Connect yetkilendirmesi yok (kitaplık okunamaz).');
    self._libraryError = err;
    self._libraryErrorAt = Date.now();
    return Promise.reject(err);
  }

  const map = {};
  // Sayfa sayısına ek olarak DUVAR SAATİ sınırı: her istek 10 sn zaman aşımına
  // sahip, 20 sayfa üst üste gelirse teorik en kötü hâl 200 sn - o kadar
  // beklerken tarayıcı çoktan pes eder. Elimizdeki sayfalarla yetiniyoruz.
  const deadline = Date.now() + LIBRARY_DEADLINE_MS;
  const fetchPage = (offset, page) => {
    if (page >= LIBRARY_MAX_PAGES) return Promise.resolve();
    if (Date.now() > deadline) {
      self.logger.warn('[mecazicards_for_spotify] Kitaplık taraması süre sınırına takıldı, ' +
        'elde edilen ' + Object.keys(map).length + ' liste ile devam ediliyor.');
      return Promise.resolve();
    }
    return self.spotifyUserApi('GET', '/v1/me/playlists?limit=50&offset=' + offset)
      .then((json) => {
        const items = (json && json.items) || [];
        items.forEach((it) => {
          // Spotify algoritmik listeleri bazen null olarak döndürüyor - atla.
          if (!it || !it.id) return;
          const imgs = it.images || [];
          map[it.id] = { name: it.name || null, image: imgs.length ? imgs[0].url : null };
        });
        if (json && json.next && items.length) return fetchPage(offset + 50, page + 1);
        return undefined;
      });
  };

  self._libraryInFlight = fetchPage(0, 0)
    .then(() => {
      self._libraryCache = map;
      self._libraryCacheAt = Date.now();
      self._libraryInFlight = null;
      self._libraryError = null;
      self.logger.info('[mecazicards_for_spotify] Kitaplıkta ' +
        Object.keys(map).length + ' liste bulundu.');
      return map;
    })
    .catch((err) => {
      self._libraryInFlight = null;
      const wrapped = /\(403\)/.test(err.message)
        ? new Error('Kitaplık izni yok (403). Galeri sayfasından yetkilendirmeyi ' +
            'YENİLE - kitaplık izinleri v3.9.4 ile eklendi, eski token onları taşımıyor.')
        : err;
      self._libraryError = wrapped;
      self._libraryErrorAt = Date.now();
      self.logger.warn('[mecazicards_for_spotify] Kitaplık okunamadı: ' + wrapped.message);
      throw wrapped;
    });

  return self._libraryInFlight;
};

ControllerMecazicards.prototype.resolveViaLibrary = function (parsed) {
  const self = this;
  if (parsed.type !== 'playlist') {
    return Promise.reject(new Error('kitaplık yalnızca çalma listeleri için kullanılıyor'));
  }
  return self.getUserPlaylistLibrary().then((map) => {
    const hit = map[parsed.id];
    if (!hit || !hit.name) {
      throw new Error('liste kitaplığında bulunamadı');
    }
    return { name: hit.name, image: hit.image, type: 'playlist', source: 'library' };
  });
};

ControllerMecazicards.prototype.resolveUriInfo = function (uri) {
  const self = this;
  const defer = libQ.defer();
  const parsed = parseSpotifyUri(uri);

  if (!parsed) {
    defer.reject(new Error('Geçersiz Spotify URI: ' + uri));
    return defer.promise;
  }

  const typeToEndpoint = { playlist: 'playlists', artist: 'artists', album: 'albums', track: 'tracks' };
  const endpoint = typeToEndpoint[parsed.type];

  if (!endpoint) {
    defer.reject(new Error('Desteklenmeyen URI tipi: ' + parsed.type));
    return defer.promise;
  }

  // Üçüncü kademe: KULLANICININ KENDİ KİTAPLIĞI.
  //
  // Blend, Daily Mix, daylist, Discover Weekly gibi kişiselleştirilmiş listeler
  // herkese açık değil - oEmbed onlara 404 verir, /v1/playlists/{id} de Spotify'ın
  // Kasım 2024 kısıtlaması yüzünden 37i9dQZ... kimliklerine kapalı. Ama kullanıcı
  // bu listeleri TAKİP ETTİĞİ için kendi kitaplığında görünüyorlar; oradan
  // gerçek adlarını ve kapaklarını alabiliyoruz.
  const fallbackToLibrary = (apiError, oembedError) => {
    self.resolveViaLibrary(parsed)
      .then((info) => defer.resolve(info))
      .catch((libError) => {
        defer.reject(new Error(
          'Web API: ' + (apiError ? apiError.message : 'atlandı') +
          ' | oEmbed: ' + (oembedError ? oembedError.message : 'atlandı') +
          ' | kitaplık: ' + libError.message
        ));
      });
  };

  const fallbackToOembed = (apiError) => {
    self.resolveViaOembed(uri)
      .then((info) => defer.resolve(info))
      .catch((oembedError) => fallbackToLibrary(apiError, oembedError));
  };

  const hasCreds = !!(self.config.get('spotify_client_id') && self.config.get('spotify_client_secret'));
  if (!hasCreds) {
    // Kimlik bilgisi girilmemişse doğrudan oEmbed'i dene - o hiçbir şey istemiyor.
    fallbackToOembed(null);
    return defer.promise;
  }

  self.spotifyApiGet('/v1/' + endpoint + '/' + parsed.id)
    .then((json) => {
      const images = json.images || (json.album && json.album.images) || [];
      const image = images.length ? images[0].url : null;
      defer.resolve({ name: json.name || uri, image: image, type: parsed.type, source: 'api' });
    })
    .fail((err) => fallbackToOembed(err));

  return defer.promise;
};

// Kayıtlı eşleştirmelerin isimlerini toplu çeker (8'erli gruplar hâlinde,
// Spotify'ı gereksiz yormamak için). forceAll=true ise zaten önbellekte olan
// isimler de yeniden çekilir.
ControllerMecazicards.prototype.refreshAllNames = function (forceAll) {
  const self = this;
  const defer = libQ.defer();
  const mappings = self.getMappings();
  const names = self.getResolvedNames();
  const cardIds = Object.keys(mappings).filter((id) => forceAll || !names[id]);
  const totalSkipped = Object.keys(mappings).length - cardIds.length;

  if (cardIds.length === 0) {
    defer.resolve({ resolved: 0, failed: 0, skipped: totalSkipped });
    return defer.promise;
  }

  let resolved = 0;
  let failed = 0;
  let viaOembed = 0;
  let viaLibrary = 0;   // Blend / Daily Mix / daylist buradan gelir
  let lastError = '';
  const CONCURRENCY = 8;
  let index = 0;

  function nextBatch() {
    if (index >= cardIds.length) {
      return libQ.resolve();
    }
    const batch = cardIds.slice(index, index + CONCURRENCY);
    index += CONCURRENCY;

    const batchPromises = batch.map((cardId) =>
      self.resolveUriInfo(mappings[cardId])
        .then((info) => {
          names[cardId] = info;
          resolved++;
          if (info.source === 'oembed') viaOembed++;
          if (info.source === 'library') viaLibrary++;
        })
        .fail((err) => {
          failed++;
          if (err && err.message) lastError = err.message;
        })
    );

    return libQ.all(batchPromises).then(nextBatch);
  }

  nextBatch().then(() => {
    // Kaydetme sırasında diskte yer kalmamışsa (SD kartlarda en sık görülen
    // arıza) config.set fırlatır. Yakalamazsak defer NE çözülür NE reddedilir:
    // /api/refresh-names hiç cevap vermez, bağlantı açık kalır, tarayıcı
    // sebebi anlaşılmayan bir "Failed to fetch" gösterir.
    try {
      // Uzun ağ turu boyunca elde tuttuğumuz kopya bayatlamış olabilir: bu
      // sırada silinmiş bir kartın ismini geri getirmeyelim, bu sırada
      // güncellenmiş bir ismi de ezmeyelim.
      const guncel = self.getResolvedNames();
      const kartlar = self.getMappings();
      const birlesik = {};
      Object.keys(guncel).forEach((id) => {
        if (kartlar[id]) birlesik[id] = guncel[id];
      });
      Object.keys(names).forEach((id) => {
        if (kartlar[id] && cardIds.indexOf(id) !== -1) birlesik[id] = names[id];
      });
      self.persistResolvedNames(birlesik);
    } catch (err) {
      self.logger.error('[mecazicards_for_spotify] İsimler kaydedilemedi: ' + err.message);
      defer.reject(new Error('İsimler çekildi ama kaydedilemedi: ' + err.message +
        ' (diskte yer kalmamış olabilir)'));
      return;
    }

    if (failed) {
      self.logger.warn('[mecazicards_for_spotify] ' + failed + ' isim çekilemedi. Son hata: ' + lastError);
    }
    defer.resolve({
      resolved: resolved, failed: failed, skipped: totalSkipped,
      viaOembed: viaOembed, viaLibrary: viaLibrary, lastError: lastError
    });
  }).fail((err) => {
    self.logger.error('[mecazicards_for_spotify] İsim yenilemede beklenmedik hata: ' + err.message);
    defer.reject(err);
  });

  return defer.promise;
};

// -------------------- HID okuma --------------------

ControllerMecazicards.prototype.startCardReader = function () {
  const self = this;
  const devicePath = (self.config.get('hid_device_path') || '/dev/mecazicards_hid').trim();

  if (!fs.existsSync(devicePath)) {
    self.logger.warn('[mecazicards_for_spotify] ' + devicePath + ' henüz hazır değil, 3sn sonra tekrar denenecek.');
    self.hidRetryTimeout = setTimeout(() => self.startCardReader(), 3000);
    return;
  }

  self.logger.info('[mecazicards_for_spotify] Kart okuyucu dinleniyor: ' + devicePath);

  // Yeni akış açmadan ÖNCE eskisini kapat.
  //
  // Bu olmadan şöyle bozuluyordu: okuyucuyu çıkarıp takınca eski akış 'error'
  // veriyor, yeniden başlatma zamanlanıyor - ama eski akış kapatılmadığı için
  // dinleyicileri üstünde kalıyor ve dosya tanıtıcısı sızıyor. İki takıp
  // çıkarmadan sonra AYNI baytları iki akış birden işliyor, tampon
  // "11223344..." gibi ikizleniyor ve hiçbir kart eşleşmiyor.
  self.closeHidStream();

  const stream = fs.createReadStream(devicePath);
  self.hidStream = stream;

  const retry = (ms, sebep) => {
    // Yalnızca GÜNCEL akış yeniden başlatmayı tetikleyebilsin; kapatılmış eski
    // bir akışın geç gelen hatası ikinci bir zincir başlatmasın.
    if (self.hidStream !== stream) return;
    self.closeHidStream();
    if (self.hidRetryTimeout) clearTimeout(self.hidRetryTimeout);
    self.hidRetryTimeout = setTimeout(() => self.startCardReader(), ms);
    self.logger.error('[mecazicards_for_spotify] HID: ' + sebep +
      ' — ' + (ms / 1000) + 'sn sonra tekrar denenecek.');
  };

  stream.on('error', (err) => retry(5000, 'okuma hatası: ' + err.message));
  stream.on('close', () => { if (self.hidStream === stream) retry(3000, 'akış kapandı'); });

  stream.on('data', (chunk) => {
    if (self.hidStream !== stream) return;   // kapatılmış akıştan gelen artık veri
    if (chunk.length >= 3) {
      const keyCode = chunk[2];
      if (keyCode !== 0) {
        self.handleKeyCode(keyCode);
      }
    }
  });
};

ControllerMecazicards.prototype.closeHidStream = function () {
  const self = this;
  if (!self.hidStream) return;
  const eski = self.hidStream;
  self.hidStream = null;
  try {
    eski.removeAllListeners();
    eski.destroy();
  } catch (err) { /* zaten kapalıysa önemsiz */ }
};

ControllerMecazicards.prototype.stopCardReader = function () {
  const self = this;
  if (self.hidRetryTimeout) {
    clearTimeout(self.hidRetryTimeout);
    self.hidRetryTimeout = null;
  }
  if (self.readingTimeout) {
    clearTimeout(self.readingTimeout);
    self.readingTimeout = null;
  }
  self.readingBuffer = '';
  self.closeHidStream();
};

// -------------------- triggerhappy çakışma engelleyici --------------------
// Kart okuyucu USB'ye standart bir klavye gibi bağlanıyor. Kernel bu yüzden
// hem /dev/hidraw (yukarıda okuduğumuz) hem de /dev/input/eventN (standart
// klavye olayları) üretiyor. Volumio'nun triggerhappy servisi ikinciyi
// dinliyor ve varsayılan olarak Enter tuşunu play/pause'a bağlamış oluyor -
// kart okutunca gönderilen "rakamlar + Enter" bu yüzden triggerhappy
// tarafından da "play/pause'a basıldı" sanılıyor ve bizim komutumuzla
// yarışıyor (şarkının birkaç kez baştan sıçraması bundan kaynaklanıyor).
// Çözüm: /dev/mecazicards_input düğümünü EVIOCGRAB ile kilitleyip bu
// olayları triggerhappy'nin görmesini tamamen engelliyoruz. Bu, SADECE bu
// RFID okuyucuyu etkiler - başka klavyeler/uzaktan kumandalar (ör. air
// mouse) normal çalışmaya devam eder.

ControllerMecazicards.prototype.startInputGrab = function () {
  const self = this;
  const devicePath = (self.config.get('input_event_device_path') || '/dev/mecazicards_input').trim();

  if (!fs.existsSync(devicePath)) {
    self.grabStatus = devicePath + ' henüz hazır değil, tekrar denenecek';
    self.grabRetryTimeout = setTimeout(() => self.startInputGrab(), 3000);
    return;
  }

  const scriptPath = path.join(__dirname, 'grab_input.py');
  const child = spawn('python3', [scriptPath, devicePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  self.grabProcess = child;

  child.stdout.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line.startsWith('grabbed:')) {
      self.grabStatus = 'aktif (' + devicePath + ')';
      self.logger.info('[mecazicards_for_spotify] triggerhappy çakışma engelleyici aktif: ' + devicePath);
    }
  });

  child.stderr.on('data', (buf) => {
    self.logger.warn('[mecazicards_for_spotify] grab_input.py: ' + buf.toString().trim());
  });

  child.on('error', (err) => {
    self.grabStatus = 'python3 çalıştırılamadı: ' + err.message;
    self.logger.error('[mecazicards_for_spotify] grab_input.py başlatılamadı: ' + err.message);
  });

  child.on('exit', (codeExit, signal) => {
    self.grabProcess = null;
    if (signal !== 'SIGTERM') {
      self.grabStatus = 'beklenmedik şekilde durdu (kod ' + codeExit + '), tekrar denenecek';
      self.logger.warn('[mecazicards_for_spotify] grab_input.py beklenmedik şekilde kapandı, 5sn sonra tekrar denenecek.');
      self.grabRetryTimeout = setTimeout(() => self.startInputGrab(), 5000);
    }
  });
};

ControllerMecazicards.prototype.stopInputGrab = function () {
  const self = this;
  if (self.grabRetryTimeout) {
    clearTimeout(self.grabRetryTimeout);
    self.grabRetryTimeout = null;
  }
  if (self.grabProcess) {
    self.grabProcess.removeAllListeners('exit');
    self.grabProcess.kill('SIGTERM');
    self.grabProcess = null;
  }
  self.grabStatus = 'durduruldu';
};

// -------------------- Cihaz listeleme (dropdown için) --------------------
// Farklı bir kart okuyucu taksan bile ayarlar sayfasından listeden seçebilmen
// için, sistemde şu an takılı olan HID/klavye cihazlarını tarıyoruz. Kernel'in
// standart sysfs arayüzlerini (hidraw uevent / input uevent) kullanıyoruz -
// bunlar Volumio'ya özel değil, her Linux sisteminde aynı şekilde çalışır.

ControllerMecazicards.prototype.listHidDevices = function () {
  const self = this;
  const results = [{ value: '/dev/mecazicards_hid', label: '/dev/mecazicards_hid (sabit - önerilen)' }];
  try {
    const hidrawDir = '/sys/class/hidraw';
    if (fs.existsSync(hidrawDir)) {
      fs.readdirSync(hidrawDir).forEach((name) => {
        try {
          const ueventPath = path.join(hidrawDir, name, 'device', 'uevent');
          let label = '/dev/' + name;
          if (fs.existsSync(ueventPath)) {
            const content = fs.readFileSync(ueventPath, 'utf8');
            const nameMatch = content.match(/HID_NAME=(.*)/);
            const idMatch = content.match(/HID_ID=\S+:0*([0-9A-Fa-f]+):0*([0-9A-Fa-f]+)/);
            const humanName = nameMatch ? nameMatch[1].trim() : name;
            const idStr = idMatch ? ' (' + idMatch[1].toLowerCase() + ':' + idMatch[2].toLowerCase() + ')' : '';
            label = '/dev/' + name + ' — ' + humanName + idStr;
          }
          results.push({ value: '/dev/' + name, label: label });
        } catch (e) { /* bu cihazı atla */ }
      });
    }
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] HID cihazları listelenemedi: ' + err.message);
  }
  return results;
};

ControllerMecazicards.prototype.listInputEventDevices = function () {
  const self = this;
  const results = [{ value: '/dev/mecazicards_input', label: '/dev/mecazicards_input (sabit - önerilen)' }];
  try {
    const inputDir = '/sys/class/input';
    if (fs.existsSync(inputDir)) {
      fs.readdirSync(inputDir).filter((n) => /^event\d+$/.test(n)).forEach((name) => {
        try {
          const ueventPath = path.join(inputDir, name, 'device', 'uevent');
          let label = '/dev/input/' + name;
          if (fs.existsSync(ueventPath)) {
            const content = fs.readFileSync(ueventPath, 'utf8');
            const nameMatch = content.match(/NAME=(.*)/);
            const humanName = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : name;
            label = '/dev/input/' + name + ' — ' + humanName;
          }
          results.push({ value: '/dev/input/' + name, label: label });
        } catch (e) { /* bu cihazı atla */ }
      });
    }
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] evdev cihazları listelenemedi: ' + err.message);
  }
  return results;
};

// Kart okuyucu rakamları tek tek "yazıyor", sonunda Enter gönderiyor. Tamponu
// yalnızca Enter temizliyordu; bu iki şekilde bozuluyor:
//   - Kart okuyucudan yarıda çekilirse yarım numara tamponda kalıyor ve BİR
//     SONRAKİ okumanın başına yapışıyor ("0007" + "0012345678") -> eşleşme yok.
//   - Enter hiç gelmezse tampon sınırsız büyüyor.
// Bu yüzden hem sessizlik zaman aşımı hem de uzunluk sınırı var.
const CARD_INPUT_TIMEOUT_MS = 400;
const CARD_ID_MAX_LEN = 32;

ControllerMecazicards.prototype.handleKeyCode = function (code) {
  const self = this;

  if (self.readingTimeout) clearTimeout(self.readingTimeout);

  if (code === HID_ENTER_CODE) {
    self.readingTimeout = null;
    if (self.readingBuffer.length > 0) {
      const cardId = self.readingBuffer;
      self.readingBuffer = '';
      self.logger.info('[mecazicards_for_spotify] Kart okundu: ' + cardId);
      self.lastCardId = cardId;
      self.triggerSpotify(cardId);
    }
    self.readingBuffer = '';
    return;
  }

  if (HID_KEYMAP[code]) {
    if (self.readingBuffer.length >= CARD_ID_MAX_LEN) {
      self.logger.warn('[mecazicards_for_spotify] Kart numarası beklenenden uzun, ' +
        'tampon sıfırlandı.');
      self.readingBuffer = '';
    }
    self.readingBuffer += HID_KEYMAP[code];
    // Yarım kalan okuma bir sonrakine bulaşmasın.
    self.readingTimeout = setTimeout(() => {
      if (self.readingBuffer) {
        self.logger.warn('[mecazicards_for_spotify] Yarım kalan okuma atıldı: ' +
          self.readingBuffer);
      }
      self.readingBuffer = '';
      self.readingTimeout = null;
    }, CARD_INPUT_TIMEOUT_MS);
  }
};

// -------------------- Oynatma mantığı --------------------
// NOT: Eski bağımsız script HTTP (axios) + socket.io ile Volumio'ya "dışarıdan"
// bağlanıyordu. Artık plugin Volumio'nun kendi process'i içinde çalıştığı için
// commandRouter üzerinden doğrudan çağrı yapıyoruz - daha hızlı ve daha sağlam
// (Volumio'nun web sunucusunun ayakta olmasına bağımlı değil).

ControllerMecazicards.prototype.triggerSpotify = function (cardId) {
  const self = this;
  const mappings = self.getMappings();
  const uri = mappings[cardId];

  if (!uri) {
    self.logger.warn('[mecazicards_for_spotify] Eşleşme bulunamadı: ' + cardId);
    self.lastUnmatchedCardId = cardId;
    self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify',
      'Tanımsız kart: ' + cardId + ' — ayarlar sayfasında "Eşleştirme Ekle" bölümüne otomatik dolduruldu.');
    return;
  }

  const lastPlayedCardId = self.config.get('last_played_card_id') || '';

  // Çalma yöntemi: 'auto' (önce Connect, olmazsa yerele düş), 'connect' (sadece
  // Connect), 'local' (sadece Volumio'nun kendi mekanizması).
  const mode = (self.config.get('playback_mode') || 'auto').trim();
  const authorized = !!(self.config.get('spotify_refresh_token') || '').trim();
  const useConnect = mode !== 'local' && authorized;
  const allowLocalFallback = mode === 'auto';

  if (mode === 'connect' && !authorized) {
    self.logger.error('[mecazicards_for_spotify] Çalma yöntemi "sadece Connect" seçili ama yetkilendirme yok.');
    self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify',
      'Çalma yöntemi "sadece Spotify Connect" ama yetkilendirme yapılmamış. Galeri sayfasından yetkilendir.');
    return;
  }

  if (lastPlayedCardId === cardId) {
    self.logger.info('[mecazicards_for_spotify] Aynı kart tekrar okundu, sonraki şarkıya geçiliyor.');
    if (useConnect) {
      self.skipToNextConnect().catch((err) =>
        self.logger.error('[mecazicards_for_spotify] Connect sonraki şarkı hatası: ' + err.message));
    } else {
      self.commandRouter.volumioNext();
    }
    return;
  }

  self.config.set('last_played_card_id', cardId);
  // İstatistiği burada yazıyoruz: aynı kartın tekrar okutulduğu dal yukarıda
  // erken çıkıyor, yani "sonraki şarkıya geç" yeni bir çalma sayılmıyor. Doğrusu
  // bu - şarkı atlamak kartı bir kez daha çalmak değil.
  self.recordCardPlay(cardId);

  if (useConnect) {
    self.getConnectDeviceId()
      .then((deviceId) => self.ensureShuffleOnConnect(deviceId).then(() => deviceId))
      .then((deviceId) => self.playViaConnect(uri, deviceId))
      .then(() => self.logger.info('[mecazicards_for_spotify] (Spotify Connect) Oynatılıyor: ' + uri))
      .catch((err) => {
        if (!allowLocalFallback) {
          self.logger.error('[mecazicards_for_spotify] Spotify Connect oynatma hatası: ' + err.message +
            ' — çalma yöntemi "sadece Connect" olduğu için yerele düşülmüyor.');
          self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify', err.message);
          return;
        }
        self.logger.error('[mecazicards_for_spotify] Spotify Connect oynatma hatası: ' + err.message +
          ' — yedek yönteme (Volumio yerel) düşülüyor.');
        self.ensureShuffleOn()
          .then(() => self.playUri(uri))
          .fail((err2) => self.logger.error('[mecazicards_for_spotify] Yedek oynatma da başarısız: ' + err2.message));
      });
  } else {
    self.ensureShuffleOn()
      .then(() => self.playUri(uri))
      .fail((err) => self.logger.error('[mecazicards_for_spotify] Oynatma hatası: ' + err.message));
  }
};

ControllerMecazicards.prototype.ensureShuffleOn = function () {
  const self = this;
  const defer = libQ.defer();
  try {
    const state = self.commandRouter.volumioGetState();
    if (state && !state.random) {
      self.commandRouter.volumioRandom(true);
      self.logger.info('[mecazicards_for_spotify] Shuffle açıldı.');
    }
    defer.resolve();
  } catch (err) {
    defer.reject(err);
  }
  return defer.promise;
};

ControllerMecazicards.prototype.playUri = function (uri) {
  const self = this;
  const defer = libQ.defer();
  try {
    self.commandRouter.replaceAndPlay({ uri: uri, service: 'spop' });
    self.logger.info('[mecazicards_for_spotify] Oynatılıyor: ' + uri);
    defer.resolve();
  } catch (err) {
    defer.reject(err);
  }
  return defer.promise;
};

// -------------------- Spotify Connect (kullanıcı OAuth'u ile çalma) --------------------
// NOT: Volumio'nun kendi "yerelden çal" mekanizması (yukarıdaki playUri/
// commandRouter.replaceAndPlay) bu cihazda ve Volumio topluluğunda başka
// kullanıcılarda da (Volumio ekibinin kendi beta forumunda kabul ettiği bir
// "librespot performans/kimlik doğrulama" sorunu) güvenilmez çalışıyor -
// Spotify Connect (telefon/PC'den "cihaz seç" ile cast) ise her zaman
// güvenilir çalışıyor. Bu bölüm, aynı sonucu (kart okutunca doğru cihazda
// çalması) Spotify'ın resmi Web API'sindeki "Connect'e komut gönder"
// uçlarını (/v1/me/player/play, /shuffle, /next) kullanarak elde ediyor -
// yani tam olarak telefondan cast eder gibi, ama otomatik. Bunun için
// kullanıcının bir kere tarayıcıdan Spotify hesabıyla yetki vermesi
// gerekiyor (bkz. /spotify-connect/authorize), aşağıdaki client-credentials
// akışından (sadece isim/kapak okuma) FARKLI, "user" tipi bir OAuth akışı.
// Eğer bu yetkilendirme yapılmamışsa (spotify_refresh_token boşsa),
// triggerSpotify eskisi gibi playUri()/commandRouter üzerinden çalışmaya
// devam ediyor - hiçbir şey bozulmuyor.

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

ControllerMecazicards.prototype.getWebUiPort = function () {
  const self = this;
  return self.config.get('web_ui_port') || 3500;
};

ControllerMecazicards.prototype.getGalleryUrl = function () {
  const self = this;
  return 'http://' + getLanIp() + ':' + self.getWebUiPort() + '/';
};

// ÖNEMLİ: Spotify, 9 Nisan 2025'ten beri redirect_uri olarak düz http'yi
// SADECE loopback adresleri (127.0.0.1) için kabul ediyor; LAN IP'si
// (192.168.x.x) veya "localhost" artık geçersiz. Bu yüzden yönlendirme
// adresimiz her zaman 127.0.0.1 üzerinden. Tarayıcı bu adrese ulaşamazsa
// (normal durum - telefon/PC'nin kendi 127.0.0.1'i cihaz değil), kullanıcı
// adres çubuğundaki URL'yi galeri sayfasındaki kutuya yapıştırıyor
// (bkz. /api/spotify-connect/manual). SSH tüneli kuranlar için otomatik
// callback de aynen çalışmaya devam ediyor.
ControllerMecazicards.prototype.getRedirectUri = function () {
  const self = this;
  return 'http://127.0.0.1:' + self.getWebUiPort() + '/spotify-connect/callback';
};

// CSRF koruması: /spotify-connect/authorize'da ürettiğimiz state ile geri
// dönen state aynı mı? (Eklenti arada yeniden başlamış olabilir diye bellekteki
// değere ek olarak diske yazdığımız değere de bakıyoruz.)
ControllerMecazicards.prototype.isValidOauthState = function (incomingState) {
  const self = this;
  const expected = self._oauthState || (self.config.get('spotify_oauth_state') || '');
  return !!expected && String(incomingState || '') === expected;
};

// Kullanıcının tarayıcının adres çubuğundan kopyalayıp yapıştırdığı geri dönüş
// adresinden (ya da doğrudan koddan) yetki kodunu çıkarır. Spotify artık düz
// http'yi sadece 127.0.0.1 için kabul ettiğinden, telefondan/PC'den yapılan
// yetkilendirmede tarayıcı bu adrese ulaşamıyor ("bağlantı reddedildi") ama
// adres çubuğunda kod görünüyor - bu fonksiyon o akışı destekliyor.
function parseAuthorizationCodeInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Boş değer yapıştırıldı.');

  if (raw.indexOf('code=') === -1 && raw.indexOf('?') === -1 && raw.indexOf('://') === -1) {
    // Kullanıcı sadece kodu yapıştırmış.
    return { code: raw, state: null };
  }

  let queryPart = raw;
  const qIndex = raw.indexOf('?');
  if (qIndex !== -1) queryPart = raw.slice(qIndex + 1);
  const parsed = querystring.parse(queryPart.split('#')[0]);

  if (parsed.error) throw new Error('Spotify yetkilendirmeyi reddetmiş: ' + parsed.error);
  if (!parsed.code) throw new Error('Yapıştırdığın adreste "code=..." bulunamadı. Tarayıcının adres çubuğundaki adresin tamamını kopyaladığından emin ol.');

  return { code: String(parsed.code), state: parsed.state ? String(parsed.state) : null };
}

// Yetki kodunu (authorization code) kalıcı refresh_token'a çevirir.
ControllerMecazicards.prototype.exchangeCodeForTokens = function (code) {
  const self = this;
  const clientId = (self.config.get('spotify_client_id') || '').trim();
  const clientSecret = (self.config.get('spotify_client_secret') || '').trim();
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: self.getRedirectUri()
  });
  const authHeader = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200 && json.access_token) {
            self.userAccessToken = json.access_token;
            self.userAccessTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
            self.config.set('spotify_refresh_token', json.refresh_token || '');
            self.saveUserState();
            // Yeniden yetkilendirme genellikle "kitaplık izni yoktu, şimdi verdim"
            // demek. Önbellekteki eski hatayı taşırsak kullanıcı izni verdiği hâlde
            // aynı hatayı görmeye devam eder - hemen temizliyoruz.
            self.clearLibraryCache('yeniden yetkilendirme');
            resolve();
          } else {
            reject(new Error('Token alınamadı (' + res.statusCode + '): ' + body));
          }
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımına uğradı.')); });
    req.write(postData);
    req.end();
  });
};

// Kalıcı refresh_token'dan taze bir access_token üretir (önbellekli).
ControllerMecazicards.prototype.getUserAccessToken = function () {
  const self = this;
  if (self.userAccessToken && Date.now() < (self.userAccessTokenExpiry || 0) - 30000) {
    return Promise.resolve(self.userAccessToken);
  }

  const refreshToken = (self.config.get('spotify_refresh_token') || '').trim();
  const clientId = (self.config.get('spotify_client_id') || '').trim();
  const clientSecret = (self.config.get('spotify_client_secret') || '').trim();

  if (!refreshToken || !clientId || !clientSecret) {
    return Promise.reject(new Error('Spotify Connect yetkilendirmesi yapılmamış (ayarlar sayfasından "Spotify Connect Yetkilendir" butonuna bas).'));
  }

  const postData = querystring.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const authHeader = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'accounts.spotify.com',
      path: '/api/token',
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200 && json.access_token) {
            self.userAccessToken = json.access_token;
            self.userAccessTokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
            // Spotify bazen refresh_token'ı da yeniler - varsa güncelle.
            if (json.refresh_token) { self.config.set('spotify_refresh_token', json.refresh_token); self.saveUserState(); }
            resolve(self.userAccessToken);
          } else {
            reject(new Error('Token yenilenemedi (' + res.statusCode + '): ' + body));
          }
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımına uğradı.')); });
    req.write(postData);
    req.end();
  });
};

// Genel amaçlı "user" tipi Spotify Web API çağrısı (player uçları için).
ControllerMecazicards.prototype.spotifyUserApi = function (method, urlPath, bodyObj) {
  const self = this;
  return self.getUserAccessToken().then((token) => new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { Authorization: 'Bearer ' + token };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({
      hostname: 'api.spotify.com',
      path: urlPath,
      method: method,
      headers: headers,
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(body ? JSON.parse(body) : {}); } catch (err) { resolve({}); }
        } else {
          reject(new Error('Spotify API ' + method + ' ' + urlPath + ' hatası (' + res.statusCode + '): ' + body));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zaman aşımına uğradı.')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  }));
};

// Kullanıcının Spotify Connect cihaz listesinden bizim Volumio cihazımızı bulur.
ControllerMecazicards.prototype.getConnectDeviceId = function () {
  const self = this;
  return self.spotifyUserApi('GET', '/v1/me/player/devices').then((json) => {
    const devices = (json && json.devices) || [];
    if (devices.length === 0) {
      throw new Error('Spotify Connect cihaz listesinde hiç cihaz görünmüyor - cihazın açık ve ağa bağlı olduğundan emin ol.');
    }
    const preferredName = (self.config.get('spotify_connect_device_name') || '').trim();

    // Hedef cihaz sabitlenmişse SADECE onu kullan. Bulunamıyorsa hata ver -
    // sessizce başka bir cihaza (Mac'in, TV'n) komut göndermek, orada çalan
    // müziği kaçırmak demek olurdu.
    if (preferredName) {
      const pinned = devices.find((d) => (d.name || '').toLowerCase() === preferredName.toLowerCase());
      if (pinned) return pinned.id;
      throw new Error('Sabitlenen Spotify Connect cihazı ("' + preferredName + '") şu an listede yok. ' +
        'Cihaz açık ve ağa bağlı mı? Galeri sayfasından başka bir cihaz seçebilir ya da sabitlemeyi kaldırabilirsin. ' +
        'Görünen cihazlar: ' + devices.map((d) => d.name).join(', '));
    }

    // Sabitlenmemişse: bu cihazın Connect'teki GERÇEK adını go-librespot'un
    // kendi yapılandırmasından okuyup onu arıyoruz. Eskiden burada
    // /volumio|mecaz/i gibi gevşek bir kalıp vardı ve "mecaz.tv" gibi başka
    // cihazlara da uyuyordu - kart okutunca müzik yanlışlıkla TV'de
    // başlıyordu. Artık isim tahmin edilmiyor, okunuyor.
    const ownName = self.getLibrespotDeviceName();
    if (ownName) {
      const own = devices.find((d) => (d.name || '').toLowerCase() === ownName.toLowerCase());
      if (own) return own.id;
      throw new Error('Bu cihaz ("' + ownName + '") Spotify Connect listesinde görünmüyor. ' +
        'Görünen cihazlar: ' + devices.map((d) => d.name).join(', ') +
        '. Yanlış cihazda çalmasın diye komut gönderilmedi.');
    }

    // Adı okuyamadıysak tahmine girmiyoruz - yanlış cihazda çalmak,
    // hiç çalmamaktan kötü.
    throw new Error('Hedef cihaz belirlenemedi (go-librespot cihaz adı okunamadı). ' +
      'Galeri sayfasındaki "Spotify Connect hedef cihazı" menüsünden cihazı sabitler misin? ' +
      'Görünen cihazlar: ' + devices.map((d) => d.name).join(', '));
  });
};

ControllerMecazicards.prototype.playViaConnect = function (uri, deviceId) {
  const self = this;
  const parsed = parseSpotifyUri(uri);
  const body = parsed && parsed.type === 'track' ? { uris: [uri] } : { context_uri: uri };
  return self.spotifyUserApi('PUT', '/v1/me/player/play?device_id=' + encodeURIComponent(deviceId), body);
};

ControllerMecazicards.prototype.ensureShuffleOnConnect = function (deviceId) {
  const self = this;
  return self.spotifyUserApi('PUT', '/v1/me/player/shuffle?state=true&device_id=' + encodeURIComponent(deviceId), null)
    .catch(() => { /* shuffle ayarlanamazsa oynatmayı engellemeyelim */ });
};

ControllerMecazicards.prototype.skipToNextConnect = function () {
  const self = this;
  return self.getConnectDeviceId().then((deviceId) =>
    self.spotifyUserApi('POST', '/v1/me/player/next?device_id=' + encodeURIComponent(deviceId), null)
  );
};

// -------------------- Gömülü web sunucusu (kart galerisi + Spotify Connect OAuth) --------------------
// Volumio'nun UIConfig.json'ı sadece basit form elemanları (input/select/
// button) destekliyor - tablo, resim gibi zengin görünümler için resmi
// Volumio eklentilerinin (ör. FM/DAB Radyo - RTL-SDR) yaptığı gibi ayrı bir
// port üzerinde kendi web sunucumuzu açıp, ayarlar sayfasına oraya giden bir
// "Aç" (openUrl tipi) buton koyuyoruz. Aynı sunucu, yukarıdaki Spotify
// Connect OAuth geri çağrısını (callback) da karşılıyor.

// -------------------- Karttaki logolar --------------------
// Kartlardaki üç logo (volumio / raspberry / spotify) varsayılan olarak
// sayfadaki yerleşik SVG çizimleriyle geliyor. Cihazın kendi dosyaları
// arasında logo aramayı bıraktık - orada bulunan dosya çoğu zaman beklenen
// kelime logosu olmuyordu. İstersen kendi görselini eklentinin "web"
// klasörüne şu isimlerle koyabilirsin, o zaman çizim yerine o kullanılır:
//   web/volumio-logo.png, web/raspberry-logo.png, web/spotify-logo.png
const CARD_ASSET_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];

ControllerMecazicards.prototype.findCustomAsset = function (baseName) {
  for (const ext of CARD_ASSET_EXTENSIONS) {
    const candidate = path.join(__dirname, 'web', baseName + ext);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) { /* önemsiz */ }
  }
  return null;
};

// -------------------- go-librespot yolları --------------------
// Açılışta Spotify oturumunu kuran mekanizma TEK: install.sh'ın kurduğu
// systemd ExecStartPre adımı (bkz. fix_librespot_config.py). Cihazda
// doğruladık - düzeltici, go-librespot'tan 2 saniye önce çalışıyor:
//
//   22:07:02  [librespot-fix] ayar zaten doğru, dokunulmadı
//   22:07:05  authenticated AP username="me*az"
//
// v3.9.3'e kadar burada ikinci bir mekanizma daha vardı: eklenti başladıktan
// 45 sn sonra config'i kontrol edip gerekirse go-librespot'u yeniden başlatan
// bir zamanlayıcı. Kaldırıldı, çünkü (a) systemd adımı doğru anda çalıştığı
// kanıtlandı, yani gereksizdi; (b) arka planda komşu bir servisi habersiz
// yeniden başlatmak gerçek bir risk - servisi Connect listesinden düşürebilir.
// İki yarım mekanizma taşımaktansa doğru anda çalışan tekini taşıyoruz.

const LIBRESPOT_CONFIG = '/data/go-librespot/config.yml';

// Bu cihazın Spotify Connect'te göründüğü adı, go-librespot'un kendi
// yapılandırmasından okur (ör. device_name: "mecaziradio"). Cihaz adını
// tahmin etmek yerine kaynağından okumak, "mecaz.tv" gibi benzer isimli
// başka cihazlara yanlışlıkla komut göndermeyi engelliyor.
// 30 saniye önbellekli - her kart okutmada dosya okumaya gerek yok.
ControllerMecazicards.prototype.getLibrespotDeviceName = function () {
  const self = this;
  if (self._librespotName !== undefined && Date.now() - (self._librespotNameAt || 0) < 30000) {
    return self._librespotName;
  }
  let name = null;
  try {
    const raw = fs.readFileSync(LIBRESPOT_CONFIG, 'utf8');
    // device_name: "mecaziradio"  /  device_name: mecaziradio
    const m = raw.match(/^\s*device_name\s*:\s*(.+?)\s*$/m);
    if (m) name = m[1].replace(/^["']|["']$/g, '').trim() || null;
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] go-librespot cihaz adı okunamadı: ' + err.message);
  }
  self._librespotName = name;
  self._librespotNameAt = Date.now();
  return name;
};

// -------------------- "Şu an çalan" tespiti --------------------
// Spotify Connect'ten o an çalan içeriğin context URI'sini alıp, hangi karta
// karşılık geldiğini buluyoruz - galeride o kart vurgulanıyor. Sayfa 4 saniyede
// bir yoklandığı için Spotify'ı yormamak adına 5 saniyelik önbellek var ve
// yenileme arka planda yapılıyor (istek beklemiyor).
ControllerMecazicards.prototype.maybeRefreshNowPlaying = function () {
  const self = this;
  if (!self.nowPlaying) {
    self.nowPlaying = { cardId: null, trackName: null, deviceName: null, isPlaying: false, fetchedAt: 0, inFlight: false };
  }
  const np = self.nowPlaying;
  const authorized = !!(self.config.get('spotify_refresh_token') || '').trim();
  if (!authorized || np.inFlight || (Date.now() - np.fetchedAt) < 5000) return;

  np.inFlight = true;
  self.spotifyUserApi('GET', '/v1/me/player', null)
    .then((json) => {
      np.inFlight = false;
      np.fetchedAt = Date.now();
      // Hiçbir şey çalmıyorsa Spotify 204 (boş gövde) dönüyor.
      if (!json || !json.item) {
        np.cardId = null; np.trackName = null; np.deviceName = null; np.isPlaying = false;
        return;
      }
      np.isPlaying = !!json.is_playing;
      np.trackName = json.item.name || null;
      np.deviceName = json.device ? json.device.name : null;
      const contextUri = (json.context && json.context.uri) || null;
      np.cardId = null;
      if (contextUri) {
        const mappings = self.getMappings();
        const match = Object.keys(mappings).find((id) => mappings[id] === contextUri);
        np.cardId = match || null;
      }
    })
    .catch(() => {
      np.inFlight = false;
      np.fetchedAt = Date.now();
    });
};

// Yerel çalmada (Volumio'nun kendi Spotify mekanizması) Spotify'ın Connect
// API'si hiçbir şey bilmiyor - bu yüzden Volumio'nun kendi oynatma durumuna
// bakıyoruz. Volumio bize sadece o an çalan PARÇAYI söylüyor, hangi çalma
// listesinden geldiğini değil; o yüzden "en son hangi kart okutulduysa o
// çalıyordur" çıkarımını yapıyoruz. Yanlış olabileceği tek durum: kartla değil
// elle Volumio arayüzünden başka bir şey başlatmışsan. Bunu sınırlamak için
// sadece Spotify servisi (spop) çalarken işaretliyoruz.
ControllerMecazicards.prototype.getLocalNowPlaying = function () {
  const self = this;
  const empty = { cardId: null, trackName: null, deviceName: null };
  try {
    const state = self.commandRouter.volumioGetState();
    if (!state || state.status !== 'play') return empty;
    if (state.service && state.service !== 'spop') return empty;

    const lastId = (self.config.get('last_played_card_id') || '').trim();
    if (!lastId) return empty;
    const mappings = self.getMappings();
    if (!mappings[lastId]) return empty;

    const title = state.title || '';
    const artist = state.artist || '';
    return {
      cardId: lastId,
      trackName: title ? (artist ? title + ' — ' + artist : title) : null,
      deviceName: 'Volumio (yerel)'
    };
  } catch (err) {
    return empty;
  }
};

ControllerMecazicards.prototype.startWebServer = function () {
  const self = this;
  const port = self.getWebUiPort();
  let indexHtml = '';
  try {
    indexHtml = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8');
  } catch (err) {
    self.logger.error('[mecazicards_for_spotify] web/index.html okunamadı: ' + err.message);
  }

  self.cardAssets = {
    volumio: self.findCustomAsset('volumio-logo'),
    brand: self.findCustomAsset('brand-logo'),
    raspberry: self.findCustomAsset('raspberry-logo'),
    spotify: self.findCustomAsset('spotify-logo')
  };

  const sendJson = (res, statusCode, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // Görsel sınırı 3 MB; base64 ~%33 şişirdiği için gövde sınırı ondan
      // BÜYÜK olmalı, yoksa kapak yükleme sunucuya hiç ulaşmadan kopuyor
      // ve kullanıcı sebepsiz bir ağ hatası görüyor.
      if (raw.length > MAX_REQUEST_BODY_BYTES) { req.destroy(); reject(new Error('İstek gövdesi çok büyük.')); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('Geçersiz JSON gövde.')); }
    });
    req.on('error', reject);
  });

  // CSRF koruması.
  //
  // Bu sunucu ev ağında, kimlik doğrulaması olmadan duruyor. readBody gövdeyi
  // Content-Type'a bakmadan JSON olarak ayrıştırdığı için, dışarıdaki herhangi
  // bir web sayfası "basit istek" (preflight'sız) göndererek kartları silebilir
  // ya da geri yükleme tetikleyebilirdi. Tarayıcı bu tür isteklere Origin
  // başlığı ekliyor; kendi sayfamızdan gelmeyen DEĞİŞTİRİCİ istekleri
  // reddediyoruz. Origin'i hiç olmayanlar (curl, script) geçebiliyor - amaç
  // tarayıcı üzerinden yapılan siteler-arası saldırıyı kesmek.
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      const host = (req.headers.host || '').split(':')[0];
      return o.hostname === host || o.hostname === '127.0.0.1' || o.hostname === 'localhost';
    } catch (err) {
      return false;
    }
  };

  const handleApi = async (req, res, urlPath) => {
    try {
      if (req.method !== 'GET' && !originAllowed(req)) {
        self.logger.warn('[mecazicards_for_spotify] Farklı kaynaktan gelen istek ' +
          'reddedildi: ' + req.headers.origin + ' -> ' + urlPath);
        return sendJson(res, 403, { ok: false,
          error: 'Bu istek başka bir sayfadan geldiği için reddedildi.' });
      }

      if (req.method === 'GET' && urlPath === '/api/state') {
        const mappings = self.getMappings();
        const names = self.getResolvedNames();
        // Arka planda tazele; bu istek beklemez, elimizdeki son değeri döner.
        self.maybeRefreshNowPlaying();
        const np = self.nowPlaying || {};
        // Spotify Connect bize kesin bilgi veriyor (context URI'sini kartla
        // eşleştiriyoruz). Ama YEREL çalmada (Volumio'nun kendi mekanizması)
        // Spotify'ın haberi olmuyor - o yüzden Volumio'nun kendi durumuna
        // bakıp, çalan varsa son okutulan kartı işaretliyoruz. Bu bir çıkarım,
        // kesin bilgi değil: arayüzde kaynağını belirtiyoruz.
        const local = self.getLocalNowPlaying();
        const nowPlayingSource = np.cardId ? 'connect' : (local.cardId ? 'local' : null);
        // Liste HER ZAMAN kart numarası sırasında gidiyor; sıralamayı tarayıcı
        // yapıyor. Böylece baskı sayfası (hep kart numarası) sunucudan gelen
        // sırayı olduğu gibi kullanabiliyor ve galeri sırası değişse bile
        // aynı sayfayı yeniden bastığında aynı 9 kart geliyor.
        const stats = self.getPlayStats();
        const statsNow = Date.now();
        const custom = self.getCustomInfo();
        const list = Object.keys(mappings).sort().map((id) => {
          const info = names[id];
          const st = stats[id] || {};
          // Elle verilen isim/görsel HER ZAMAN üstün - kullanıcı Spotify'a
          // rağmen ne yazdıysa o geçerli.
          const cu = custom[id] || {};
          return {
            cardId: id,
            uri: mappings[id],
            name: cu.name || (info && info.name) || null,
            image: cu.image
              ? ('/card-image/' + id + '?v=' + (cu.imageAt || 0))
              : ((info && info.image) || null),
            customName: !!cu.name,
            customImage: !!cu.image,
            playCount: Number(st.count) || 0,
            lastPlayed: Number(st.last) || 0,
            // Erimiş puanı sunucuda hesaplayıp gönderiyoruz - tarayıcının saati
            // yanlışsa sıralama bozulmasın diye.
            score: decayScore(Number(st.score) || 0, Number(st.scoreAt) || 0, statsNow)
          };
        });
        return sendJson(res, 200, {
          lastCardId: self.lastCardId || null,
          lastUnmatchedCardId: self.lastUnmatchedCardId || null,
          grabStatus: self.grabStatus,
          spotifyConfigured: !!(self.config.get('spotify_client_id') && self.config.get('spotify_client_secret')),
          spotifyClientId: self.config.get('spotify_client_id') || '',
          connectAuthorized: !!(self.config.get('spotify_refresh_token') || '').trim(),
          redirectUri: self.getRedirectUri(),
          codeVersion: PLUGIN_CODE_VERSION,
          diskVersion: getDiskVersion(),
          assets: {
            brand: !!(self.cardAssets && self.cardAssets.brand),
            volumio: !!(self.cardAssets && self.cardAssets.volumio),
            raspberry: !!(self.cardAssets && self.cardAssets.raspberry),
            spotify: !!(self.cardAssets && self.cardAssets.spotify)
          },
          cardCount: Object.keys(mappings).length,
          resolvedCount: Object.keys(names).length,
          nowPlayingCardId: np.cardId || local.cardId || null,
          nowPlayingTrack: np.cardId ? (np.trackName || null) : (local.trackName || np.trackName || null),
          nowPlayingDevice: np.cardId ? (np.deviceName || null) : (local.deviceName || np.deviceName || null),
          nowPlayingIsPlaying: !!(np.isPlaying || local.cardId),
          nowPlayingSource: nowPlayingSource,
          lastPlayedCardId: self.config.get('last_played_card_id') || null,
          connectDeviceName: (self.config.get('spotify_connect_device_name') || '').trim(),
          playbackMode: (self.config.get('playback_mode') || 'auto').trim(),
          gallerySort: (function () {
            const s = (self.config.get('gallery_sort') || '').trim();
            return GALLERY_SORTS.indexOf(s) === -1 ? GALLERY_SORT_DEFAULT : s;
          })(),
          mappings: list
        });
      }

      // Spotify Connect'te görünen cihazları listele (hedef cihazı sabitlemek için).
      if (req.method === 'GET' && urlPath === '/api/connect-devices') {
        self.spotifyUserApi('GET', '/v1/me/player/devices', null)
          .then((json) => sendJson(res, 200, {
            ok: true,
            devices: ((json && json.devices) || []).map((d) => ({
              id: d.id, name: d.name, type: d.type, isActive: !!d.is_active
            }))
          }))
          .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/playback-mode') {
        const body = await readBody(req);
        const mode = (body.mode || 'auto').trim();
        if (['auto', 'connect', 'local'].indexOf(mode) === -1) {
          return sendJson(res, 400, { ok: false, error: 'Geçersiz çalma yöntemi: ' + mode });
        }
        self.config.set('playback_mode', mode);
        self.saveUserState();
        self.logger.info('[mecazicards_for_spotify] Çalma yöntemi: ' + mode);
        return sendJson(res, 200, { ok: true, mode: mode });
      }

      // Karta elle isim / görsel ver (ya da kaldır).
      if (req.method === 'POST' && urlPath === '/api/card-info') {
        const body = await readBody(req);
        try {
          const saved = self.saveCustomCardInfo(
            body.cardId, body.name, body.image, !!body.clearImage);
          self.logger.info('[mecazicards_for_spotify] Kart bilgisi güncellendi: ' + body.cardId);
          return sendJson(res, 200, { ok: true, info: saved });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      // Yedek indir. Content-Disposition ile tarayıcı doğrudan dosyaya kaydediyor.
      if (req.method === 'GET' && urlPath === '/api/backup') {
        const backup = self.buildBackup();
        const stamp = new Date().toISOString().slice(0, 10);
        const body = JSON.stringify(backup, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mecazicards-yedek-' + stamp + '.json"',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store'
        });
        return res.end(body);
      }

      // Geri yükle. Geri yüklemeden önce mevcut durum diske yazılıyor.
      if (req.method === 'POST' && urlPath === '/api/restore') {
        const body = await readBody(req);
        const mode = (body.mode === 'replace') ? 'replace' : 'merge';
        try {
          const result = self.applyBackup(body.backup, mode);
          return sendJson(res, 200, Object.assign({ ok: true }, result));
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      // Galeri sıralaması. Cihazda saklıyoruz ki telefonla masaüstü aynı
      // sırayı görsün. Baskı sırası bundan ETKİLENMİYOR - orası hep kart
      // numarası, çünkü aynı sayfayı yeniden bastığında aynı 9 kart gelmeli.
      if (req.method === 'POST' && urlPath === '/api/gallery-sort') {
        const body = await readBody(req);
        const sort = (body.sort || GALLERY_SORT_DEFAULT).trim();
        if (GALLERY_SORTS.indexOf(sort) === -1) {
          return sendJson(res, 400, { ok: false, error: 'Geçersiz sıralama: ' + sort });
        }
        self.config.set('gallery_sort', sort);
        self.saveUserState();
        return sendJson(res, 200, { ok: true, sort: sort });
      }

      // Hedef cihazı sabitle (boş gönderirsen otomatik seçime döner).
      if (req.method === 'POST' && urlPath === '/api/connect-device') {
        const body = await readBody(req);
        const name = (body.name || '').trim();
        self.config.set('spotify_connect_device_name', name);
        self.saveUserState();
        self.logger.info('[mecazicards_for_spotify] Connect hedef cihazı: ' + (name || '(otomatik)'));
        return sendJson(res, 200, { ok: true, name: name });
      }

      if (req.method === 'POST' && urlPath === '/api/mappings') {
        const body = await readBody(req);
        const result = self.validateAndPersistMapping(body.card_id, body.spotify_uri);
        return sendJson(res, 200, { ok: true, isUpdate: result.isUpdate });
      }

      if (req.method === 'POST' && urlPath === '/api/mappings/delete') {
        const body = await readBody(req);
        self.removeMappingCore(body.card_id);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && urlPath === '/api/spotify-credentials') {
        const body = await readBody(req);
        self.config.set('spotify_client_id', (body.client_id || '').trim());
        self.config.set('spotify_client_secret', (body.client_secret || '').trim());
        self.saveUserState();
        self.spotifyToken = null;
        self.spotifyTokenExpiry = 0;
        if (!self.config.get('spotify_client_id') || !self.config.get('spotify_client_secret')) {
          return sendJson(res, 200, { ok: true, result: null });
        }
        self.refreshAllNames(true)
          .then((result) => sendJson(res, 200, { ok: true, result: result }))
          .fail((err) => sendJson(res, 200, { ok: true, result: null, warning: err.message }));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/spotify-connect/manual') {
        const body = await readBody(req);
        const parsedInput = parseAuthorizationCodeInput(body.redirect_url);
        // State geri döndüyse doğrula; kullanıcı sadece kodu yapıştırdıysa
        // (state yoksa) kabul ediyoruz - bu akışta kodu bizzat kullanıcı
        // taşıdığı için CSRF riski yok.
        if (parsedInput.state && !self.isValidOauthState(parsedInput.state)) {
          return sendJson(res, 400, { ok: false, error: 'Güvenlik kodu (state) eşleşmedi. "Spotify Connect Yetkilendir" adımını baştan yapar mısın?' });
        }
        self.exchangeCodeForTokens(parsedInput.code)
          .then(() => {
            self.config.set('spotify_oauth_state', '');
            self._oauthState = null;
            self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Spotify Connect yetkilendirmesi başarılı.');
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/refresh-names') {
        self.refreshAllNames(true)
          .then((result) => sendJson(res, 200, { ok: true, result: result }))
          .fail((err) => sendJson(res, 400, { ok: false, error: err.message }));
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Bulunamadı.' });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
  };

  self.webServer = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const query = nodeUrl.parse(req.url, true).query;

    if (urlPath === '/spotify-connect/authorize') {
      const clientId = (self.config.get('spotify_client_id') || '').trim();
      if (!clientId) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Önce ayarlar sayfasından Spotify Client ID/Secret gir.</h2>');
        return;
      }
      const state = crypto.randomBytes(16).toString('hex');
      self._oauthState = state;
      // Eklenti yetkilendirme ile yapıştırma arasında yeniden başlarsa state
      // kaybolmasın diye diske de yazıyoruz.
      self.config.set('spotify_oauth_state', state);
      const authUrl = 'https://accounts.spotify.com/authorize?' + querystring.stringify({
        response_type: 'code',
        client_id: clientId,
        // Çalma izinleri + kitaplık okuma.
        //
        // Kitaplık izinleri, Blend / Daily Mix / Discover Weekly gibi
        // KİŞİSELLEŞTİRİLMİŞ listelerin ismini ve kapağını çekebilmek için
        // gerekiyor. Bu listeler herkese açık olmadığı için oEmbed'e 404
        // veriyor, /v1/playlists/{id} de Spotify'ın Kasım 2024 kısıtlaması
        // yüzünden 37i9dQZ... kimliklerine üçüncü partiye kapalı. Geriye
        // kullanıcının kendi kitaplığı kalıyor - ama o da izin istiyor:
        // izinsiz çağrı 403 döner (404 değil; "yok" değil, "yetkin yok").
        scope: [
          'user-modify-playback-state',
          'user-read-playback-state',
          'playlist-read-private',
          'playlist-read-collaborative'
        ].join(' '),
        redirect_uri: self.getRedirectUri(),
        state: state
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (urlPath === '/spotify-connect/callback') {
      if (query.error) {
        // XSS: query.error adres çubuğundan gelir ve bu dal state kontrolünden
        // ÖNCE çalışır - yani kimlik doğrulaması olmadan. Kaçırılmadan basılırsa
        // saldırganın script'i galeri sayfasının kaynağında çalışır ve oradan
        // bütün API uçları aynı kaynaktan erişilebilir olur.
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Yetkilendirme reddedildi: ' + escapeHtml(query.error) + '</h2>');
        return;
      }
      if (!self.isValidOauthState(query.state) || !query.code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>Geçersiz istek (state eşleşmedi). Ayarlar sayfasından tekrar dener misin?</h2>');
        return;
      }
      self.exchangeCodeForTokens(query.code)
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Yetkilendirme başarılı! Bu sekmeyi kapatabilirsin.</h2>');
          self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Spotify Connect yetkilendirmesi başarılı.');
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Hata: ' + err.message + '</h2>');
        });
      return;
    }

    if (urlPath.indexOf('/api/') === 0) {
      handleApi(req, res, urlPath);
      return;
    }

    // Elle yüklenmiş kart görselleri. Adreste ?v=<zaman> olduğu için uzun
    // önbellek güvenli: görsel değişince adres de değişiyor.
    if (req.method === 'GET' && urlPath.indexOf('/card-image/') === 0) {
      try {
        const id = safeCardId(decodeURIComponent(urlPath.slice('/card-image/'.length)));
        const entry = self.getCustomInfo()[id];
        if (!entry || !entry.image) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Görsel yok.');
        }
        const file = path.join(self.getCustomImageDir(), entry.image);
        const data = fs.readFileSync(file);
        const ext = path.extname(file).toLowerCase();
        const types = { '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=86400'
        });
        return res.end(data);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Görsel bulunamadı.');
      }
    }

    if (req.method === 'GET' && urlPath.indexOf('/assets/') === 0) {
      const key = urlPath.slice('/assets/'.length).replace('-logo', '');
      const assetPath = self.cardAssets && self.cardAssets[key];
      if (!assetPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Görsel bulunamadı.');
        return;
      }
      try {
        const data = fs.readFileSync(assetPath);
        const ext = path.extname(assetPath).toLowerCase();
        const types = {
          '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg', '.webp': 'image/webp'
        };
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Content-Length': data.length,
          // Adreste sürüm etiketi olduğu için uzun önbellek gerekmiyor;
          // sürüm etiketi olmayan bir istek gelirse diye kısa tutuyoruz.
          'Cache-Control': 'public, max-age=3600'
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Görsel okunamadı.');
      }
      return;
    }

    if (urlPath === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      // Önbelleğe alınmasın: eklenti güncellendiğinde tarayıcının eski
      // arayüzü göstermesi, "sanki eski sürüm kurulmuş" gibi kafa karıştırıyordu.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(indexHtml);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bulunamadı.');
  });

  self.webServer.on('error', (err) => {
    self.logger.error('[mecazicards_for_spotify] Web sunucusu başlatılamadı (port ' + port + '): ' + err.message);
  });

  self.webServer.listen(port, () => {
    self.logger.info('[mecazicards_for_spotify] Web arayüzü hazır (kod v' +
      PLUGIN_CODE_VERSION + '): ' + self.getGalleryUrl());
  });
};

ControllerMecazicards.prototype.stopWebServer = function () {
  const self = this;
  if (self.webServer) {
    try { self.webServer.close(); } catch (err) { /* zaten kapanmışsa önemsiz */ }
    self.webServer = null;
  }
};

// -------------------- UI Config (Ayarlar sayfası) --------------------

ControllerMecazicards.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();

  fs.readJson(path.join(__dirname, 'UIConfig.json'))
    .then((uiconf) => {
      const mappings = self.getMappings();
      const cardCount = Object.keys(mappings).length;
      const lastCard = self.lastCardId || '-';

      // Bölümleri numarayla değil id ile buluyoruz - araya yeni bir bölüm
      // eklendiğinde diğerlerinin kayıp bozulmaması için.
      const section = (id) => uiconf.sections.find((s) => s.id === id);
      const resolvedNames = self.getResolvedNames();
      const resolvedCount = Object.keys(resolvedNames).length;

      // Kart Okuyucu Ayarları - HID ve evdev cihazlarını dropdown olarak
      // dolduruyoruz, böylece başka bir okuyucu taksan listeden seçebiliyorsun.
      const generalSection = section('section_general');
      if (generalSection) {
        const currentHidPath = self.config.get('hid_device_path') || '/dev/mecazicards_hid';
        const currentInputPath = self.config.get('input_event_device_path') || '/dev/mecazicards_input';

        const hidOptions = self.listHidDevices();
        const inputOptions = self.listInputEventDevices();
        const findOption = (options, val) => options.find((o) => o.value === val) || { value: val, label: val + ' (şu an bağlı değil)' };

        generalSection.content[0].options = hidOptions;
        generalSection.content[0].value = findOption(hidOptions, currentHidPath);
        generalSection.content[1].options = inputOptions;
        generalSection.content[1].value = findOption(inputOptions, currentInputPath);

        // Son okunan kartın yanında eşleştiği listenin/sanatçının adı da yazsın.
        const lastInfo = self.lastCardId && mappings[self.lastCardId]
          ? ' (' + ((resolvedNames[self.lastCardId] || {}).name || mappings[self.lastCardId]) + ')'
          : '';
        generalSection.description = 'Son okunan kart: ' + lastCard + lastInfo +
          ' | Kayıtlı eşleştirme sayısı: ' + cardCount +
          ' | triggerhappy çakışma engelleyici: ' + (self.grabStatus || 'bilinmiyor');
      }

      // Çalma Yöntemi
      const playbackSection = section('section_playback');
      if (playbackSection) {
        const mode = (self.config.get('playback_mode') || 'auto').trim();
        const options = playbackSection.content[0].options;
        const opt = options.find((o) => o.value === mode) || options[0];
        playbackSection.content[0].value = { value: opt.value, label: opt.label };
        const authorized = !!(self.config.get('spotify_refresh_token') || '').trim();
        playbackSection.description = authorized
          ? 'Spotify Connect yetkilendirmesi aktif. "Otomatik" modda önce Connect denenir, hata olursa Volumio\'nun kendi yöntemine düşülür.'
          : 'Spotify Connect yetkilendirmesi yok - şu an hangi mod seçili olursa olsun Volumio\'nun kendi yöntemi kullanılıyor.';
      }

      // Spotify API Kimlik Bilgileri
      const credsSection = section('section_spotify_credentials');
      if (credsSection) {
        credsSection.content[0].value = self.config.get('spotify_client_id') || '';
        credsSection.content[1].value = self.config.get('spotify_client_secret') || '';
        const hasSpotifyCreds = !!(self.config.get('spotify_client_id') && self.config.get('spotify_client_secret'));
        credsSection.description = hasSpotifyCreds
          ? 'Spotify API bilgileri kayıtlı. İsim/kapak gösterimi ve Spotify Connect yetkilendirmesi için kullanılıyor.'
          : 'Henüz girilmedi. (İsimler kimlik bilgisi olmadan da oEmbed üzerinden çekilebiliyor; Connect yetkilendirmesi içinse şart.)';
      }

      // İsimleri Yenile
      const refreshSection = section('section_refresh_names');
      if (refreshSection) {
        refreshSection.description = 'Şu an ' + resolvedCount + ' / ' + cardCount + ' eşleştirmenin ismi çekilmiş durumda.';
      }

      // Kayıtlı Eşleştirmeler (salt okunur özet)
      const listSection = section('section_mapping_list');
      if (listSection) {
        listSection.description = cardCount
          ? Object.keys(mappings).sort().map((id) => {
              const info = resolvedNames[id];
              return (info && info.name)
                ? id + '  →  ' + info.name + '  (' + mappings[id] + ')'
                : id + '  →  ' + mappings[id];
            }).join('\n')
          : '(Henüz eşleştirme yok)';
      }

      // Eşleştirme Ekle/Güncelle - tanınmayan bir kart okutulduysa ID'sini
      // otomatik dolduruyoruz.
      const addSection = section('section_add_mapping');
      if (addSection && self.lastUnmatchedCardId) {
        addSection.content[0].value = self.lastUnmatchedCardId;
        addSection.description = 'Tanınmayan kart algılandı ve aşağıya dolduruldu: ' +
          self.lastUnmatchedCardId + '. Spotify URI\'sini girip kaydet.';
      }

      // section_web_ui = Kart Galerisi (gömülü web sunucusu) + Spotify Connect
      // yetkilendirme butonu.
      const webSection = section('section_web_ui');
      if (webSection) {
        // Her iki buton da galeri sayfasına gidiyor: yetkilendirme akışı
        // (Spotify'ın 127.0.0.1 zorunluluğu yüzünden) adres yapıştırma adımı
        // içerdiğinden, oradaki adım adım rehberle yapılması gerekiyor.
        webSection.content[0].onClick.url = self.getGalleryUrl();
        webSection.content[1].onClick.url = self.getGalleryUrl();
        const connectAuthorized = !!(self.config.get('spotify_refresh_token') || '').trim();
        webSection.description = 'Kart galerisi: ' + self.getGalleryUrl() +
          ' | Spotify Connect yetkilendirmesi: ' +
          (connectAuthorized
            ? 'aktif ✓ (kartlar Spotify Connect üzerinden çalıyor)'
            : 'yapılmadı (kartlar Volumio\'nun kendi mekanizmasıyla çalmayı deniyor - bu cihazda güvenilmez olabilir). Galeri sayfasını açıp oradaki 3 adımlık "Spotify Connect Yetkilendirme" bölümünü tamamla.') +
          ' | Spotify Dashboard\'a eklenmesi gereken Redirect URI: ' + self.getRedirectUri();
      }

      defer.resolve(uiconf);
    })
    .catch((err) => {
      self.logger.error('[mecazicards_for_spotify] UIConfig oluşturulamadı: ' + err.message);
      defer.reject(new Error());
    });

  return defer.promise;
};

// select elemanlarından gelen veri bazen bare string, bazen {value,label}
// nesnesi olarak geliyor - ikisini de kabul edelim.
function extractSelectValue(raw, fallback) {
  if (raw && typeof raw === 'object' && 'value' in raw) {
    return String(raw.value).trim();
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return fallback;
}

ControllerMecazicards.prototype.saveGeneralSettings = function (data) {
  const self = this;
  const newHidPath = extractSelectValue(data['hid_device_path'], '/dev/mecazicards_hid');
  const newInputPath = extractSelectValue(data['input_event_device_path'], '/dev/mecazicards_input');

  self.config.set('hid_device_path', newHidPath);
  self.config.set('input_event_device_path', newInputPath);

  self.stopCardReader();
  self.startCardReader();
  self.stopInputGrab();
  self.startInputGrab();

  self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Ayarlar kaydedildi, kart okuyucu yeniden başlatıldı.');
  return libQ.resolve();
};

ControllerMecazicards.prototype.savePlaybackMode = function (data) {
  const self = this;
  const mode = extractSelectValue(data['playback_mode'], 'auto');

  if (['auto', 'connect', 'local'].indexOf(mode) === -1) {
    self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify', 'Geçersiz çalma yöntemi: ' + mode);
    return libQ.resolve();
  }

  self.config.set('playback_mode', mode);
  const labels = {
    auto: 'Otomatik (önce Spotify Connect, olmazsa yerel)',
    connect: 'Sadece Spotify Connect',
    local: 'Sadece Volumio\'nun kendi yöntemi'
  };
  self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Çalma yöntemi: ' + labels[mode]);
  return libQ.resolve();
};

ControllerMecazicards.prototype.saveSpotifyCredentials = function (data) {
  const self = this;
  const clientId = (data['spotify_client_id'] || '').trim();
  const clientSecret = (data['spotify_client_secret'] || '').trim();

  self.config.set('spotify_client_id', clientId);
  self.config.set('spotify_client_secret', clientSecret);
  self.spotifyToken = null;
  self.spotifyTokenExpiry = 0;

  if (!clientId || !clientSecret) {
    self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Spotify API bilgileri temizlendi.');
    return libQ.resolve();
  }

  self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Kaydedildi, isimler arka planda çekiliyor…');

  self.refreshAllNames(true)
    .then((result) => {
      self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify',
        'İsimler güncellendi: ' + result.resolved + ' başarılı, ' + result.failed + ' başarısız.');
    })
    .fail((err) => {
      self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify',
        'İsimler çekilemedi (Client ID/Secret\'ı kontrol et): ' + err.message);
    });

  return libQ.resolve();
};

ControllerMecazicards.prototype.refreshSpotifyNames = function () {
  const self = this;
  self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'İsimler yenileniyor…');

  self.refreshAllNames(true)
    .then((result) => {
      self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify',
        'İsimler güncellendi: ' + result.resolved + ' başarılı, ' + result.failed + ' başarısız.');
    })
    .fail((err) => {
      self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify', 'İsimler çekilemedi: ' + err.message);
    });

  return libQ.resolve();
};

// Ortak dogrulama+kayit mantigi - hem Volumio ayarlar sayfasindaki (UIConfig)
// formdan hem de gomulu web sunucusunun /api/mappings ucundan cagriliyor,
// boylece mantik iki yerde de tekrar edilmiyor.
ControllerMecazicards.prototype.validateAndPersistMapping = function (rawCardId, rawUri) {
  const self = this;
  const cardId = (rawCardId || '').trim();
  const uri = (rawUri || '').trim();

  if (!cardId || !uri) {
    throw new Error('Kart ID ve Spotify URI boş olamaz.');
  }
  if (!/^spotify:(playlist|artist|album|track):/.test(uri)) {
    throw new Error("URI 'spotify:playlist:...', 'spotify:artist:...', 'spotify:album:...' veya 'spotify:track:...' ile başlamalı.");
  }

  const mappings = self.getMappings();
  const isUpdate = Object.prototype.hasOwnProperty.call(mappings, cardId);
  mappings[cardId] = uri;
  self.persistMappings(mappings);

  if (self.lastUnmatchedCardId === cardId) {
    self.lastUnmatchedCardId = '';
  }

  // Arka planda, engellemeden isim + kapak görselini çekmeyi dene.
  self.resolveUriInfo(uri)
    .then((info) => {
      const names = self.getResolvedNames();
      names[cardId] = info;
      self.persistResolvedNames(names);
    })
    .fail(() => { /* Spotify bilgisi girilmemiş veya API hatası - sessizce geç */ });

  return { isUpdate: isUpdate, cardId: cardId };
};

ControllerMecazicards.prototype.removeMappingCore = function (rawCardId) {
  const self = this;
  const cardId = (rawCardId || '').trim();
  const mappings = self.getMappings();

  if (!cardId || !Object.prototype.hasOwnProperty.call(mappings, cardId)) {
    throw new Error('Bu kart ID için eşleştirme bulunamadı: ' + cardId);
  }

  delete mappings[cardId];
  self.persistMappings(mappings);

  const names = self.getResolvedNames();
  if (Object.prototype.hasOwnProperty.call(names, cardId)) {
    delete names[cardId];
    self.persistResolvedNames(names);
  }

  // Elle verilen isim/kapağı da temizle. Aksi hâlde kapak dosyası diskte öksüz
  // kalıyor ve aynı kart numarası ileride BAŞKA bir listeye eşlenirse eski
  // isim/kapak yeni listenin üstünde görünüyordu.
  try {
    const ozel = self.getCustomInfo();
    if (Object.prototype.hasOwnProperty.call(ozel, cardId)) {
      self.saveCustomCardInfo(cardId, '', null, true);
    }
  } catch (err) {
    self.logger.warn('[mecazicards_for_spotify] Özel isim/kapak temizlenemedi: ' + err.message);
  }

  return { cardId: cardId };
};

ControllerMecazicards.prototype.addOrUpdateMapping = function (data) {
  const self = this;
  try {
    const result = self.validateAndPersistMapping(data['card_id'], data['spotify_uri']);
    self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify',
      (result.isUpdate ? 'Eşleştirme güncellendi: ' : 'Eşleştirme eklendi: ') + result.cardId);
  } catch (err) {
    self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify', err.message);
  }
  return libQ.resolve();
};

ControllerMecazicards.prototype.removeMapping = function (data) {
  const self = this;
  try {
    const result = self.removeMappingCore(data['card_id_to_remove']);
    self.commandRouter.pushToastMessage('success', 'mecazicards for Spotify', 'Eşleştirme silindi: ' + result.cardId);
  } catch (err) {
    self.commandRouter.pushToastMessage('error', 'mecazicards for Spotify', err.message);
  }
  return libQ.resolve();
};
