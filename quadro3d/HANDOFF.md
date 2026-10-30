# Quadro 3D — devir notu (handoff)

Bu not, yeni bir Claude oturumunun işi kaldığı yerden devralması için yazıldı. Yeni oturumda:
**"quadro3d/HANDOFF.md dosyasını oku, kaldığın yerden devam et"** demek yeterli.

Son güncelleme: 30 Ekim 2026. Her şey canlıda ve iki depo da temiz (commit edilmemiş iş yok).

---

## 1. Kimin için, nasıl çalışılır

- Kullanıcı: Hüseyin, Co Print'in CTO'su ve kurucu ortağı. Ürün: **Co Print Quadro**, 4 bağımsız takım kafalı 3D yazıcı.
- Kullanıcı **iPhone/iPad** ile çalışıyor. **Her zaman Türkçe** cevap ver.
- Teknik işi sen yap, adım adım ilerle, olmayan özelliği varmış gibi gösterme. Ekran görüntüleriyle yönlendirme yaparken her adımı açık yaz.
- API anahtarı veya token'ı asla sohbete yapıştırmasını isteme.
- Commit mesajlarında model adı geçmesin.
- Çalışma düzeni: değişiklik önce **önizlemeye** (preview) gider. Kullanıcı "yayınla" veya "canlıya al" deyince **ana siteye** ve claude.ai artifact'ına geçer.

## 2. Canlı adresler

| Ne | Adres |
|---|---|
| Ana site (GitHub Pages) | https://huseyinozn.github.io/quadro-3d/ |
| Önizleme | https://huseyinozn.github.io/quadro-3d/preview/ |
| claude.ai artifact (çok dosyalı) | https://claude.ai/artifact/RrbLYpHB5pLeiXnszcx2qs |
| Dilimleme servisi (Google Cloud Run) | https://quadro-slicer-312122953843.europe-west1.run.app |
| "Ask about Quadro" worker (Cloudflare) | https://quadro-ask.huseyin-926.workers.dev |

## 3. Depolar

- **huseyinozn/Anatomy-deneme** (dal: `master`): kaynak kod burada, klasör `quadro3d/`.
- **huseyinozn/quadro-3d** (dal: `main`): GitHub Pages çıktısı.
  - Kök klasör ana site, `preview/` klasörü önizleme.
  - Elle düzenlenmez, `build-pages.sh` ile üretilir.

### quadro3d/ içeriği

| Dosya | Görevi |
|---|---|
| `index.html` | Sayfanın tamamı (doctype yok; Pages build sarar): three.js sahnesi, simülasyon, panolar, dilimleme kartı, Ask kutusu |
| `klipper.js` | Yazıcının Klipper host'unun tarayıcıdaki modeli. `printer-config.json`'daki gerçek makro ve modülleri çalıştırır |
| `jinja.js` | Klipper makroları için Jinja yorumlayıcısı |
| `screen.js` | QuadroScreen'in web kopyası (800×480 dokunmatik ekran): ana sayfa, dosyalar, baskı, hareket, filament, kalibrasyon, sıcaklık, fan |
| `qs/` | Ekranın görselleri (QuadroScreen 0.2.22'den) |
| `printer-config.json` | Yazıcının `printer_data/config` dosyaları |
| `quadro.glb` | Üretim CAD modeli (KHR_mesh_quantization). Bu depoda `.gitignore`'da; kopyası quadro-3d deposunda `quadro.glb` olarak duruyor, oradan alınır |
| `quadro-glb.txt` | Aynı modelin base64 hali. Artifact .glb sunamadığı için var. O da `.gitignore`'da; `base64 -w0 quadro.glb > quadro-glb.txt` ile yeniden üretilir |
| `build-pages.sh <hedef>` | Pages için çıktı üretir (MODEL_URL'i quadro.glb'ye çevirir, dosyaları kopyalar) |
| `build-single.py <three vendor> <çıktı>` | Tek dosyalık sürüm (`dist/`, git'e girmez) |
| `slicer-server/` | Dilimleme servisi (Bölüm 5) |
| `ask-worker/` | Ask worker'ı ve bilgi tabanı (Bölüm 6) |

## 4. Sayfanın özellikleri

1. **3D yazıcı simülasyonu:**
   - Takım değişimleri, Qdock park yerleri ve nozzle kapakları var.
   - PTFE borular ve kablolar kafalar hareket ettikçe yeniden çiziliyor.
   - Oda ve masa sahnesi var.
2. **Konsol:** Yazıcının gerçek Klipper config'i ve makroları tarayıcıda çalışıyor. HELP tüm komutları listeler.
3. **Yazıcı ekranı (QuadroScreen kopyası):**
   - Dosyalar sayfası: demo küp ve sayfada dilimlenen modeller.
   - Baskı, hareket, filament, sıcaklık ve fan sayfaları.
   - Kalibrasyon akışları: full, bed, tool, shaper. Aşamalar `CALIBRATION_STATUS` makro değişkeninden okunuyor.
4. **Dilimleme kartı ("Slice your model"):**
   - Yüklenen 3MF veya STL, Bambu A1 combo, Snapmaker U1 ve Quadro için aynı anda dilimleniyor.
   - Tabloda süre, model gramı, prime tower, flush (poop) ve toplam atık var. En iyi değerler yeşil gösteriliyor.
   - Geçen süre için bir sayaç var.
   - Quadro dosyası ekranın Files listesine düşüyor. **Print** ile simülasyonda basılıyor, **Download G-code** ile iniyor.
5. **Dilimlenen modeli basma:**
   - Sunucunun döndürdüğü toolpath katman katman oynatılıyor; takım değişimleri gerçek, renkler modelin kendi renkleri.
   - Dış duvarlar ışıkla gölgelenen "boncuk" geometrisiyle çiziliyor, katman çizgileri ve doku görünüyor. Gerisi çizgi olarak çiziliyor.
   - Hareketler sabit 350 mm/s ile oynatılıyor; gerçek süre tahmini tablodaki değer.
6. **Ask about Quadro:** Cloudflare worker üzerinden Claude'a soru sorma kutusu.

## 5. Dilimleme servisi (slicer-server)

**Barındırma (Google Cloud Run):**
- Proje numarası 312122953843, bölge europe-west1, servis adı `quadro-slicer`.
- Cloud Build GitHub'dan otomatik kuruyor: `huseyinozn/Anatomy-deneme`, dal `^master$`, Dockerfile yolu `/quadro3d/slicer-server/Dockerfile`.
  - **master'a her push yeniden kurulumu tetikler** (yaklaşık 5–7 dakika).
- Ayarlar:
  - Public access, Request-based billing.
  - Instance sayısı min 0, max 2.
  - **4 CPU, 8 GiB**, request timeout **900 s**, eşzamanlı istek 2.
  - Second generation, Startup CPU boost açık.
  - Default compute service account.
- Kullanıcının gcloud yetkisi bu oturumlarda yok. Konsol ayarlarını kullanıcı telefondan yapıyor, sen ekran ekran tarif ediyorsun.

**Uç noktalar:**
- `POST /slice`: gövde model dosyası, başlık `X-Filename`. Dönen yapı `{job, file, colours, printers:{a1,u1,quadro}}`.
  - `quadro` girdisinde ayrıca `toolpath` var.
- `GET /gcode/<job>`: bir saat saklanır, `Content-Disposition` ile iner.
- `GET /health`.
- Yanıtlar gzip'li. Cloud Run 32 MB'tan büyük yanıtı reddediyor; kardan adamın G-code'u 37 MB, sıkışınca 11 MB.
- Ortam değişkenleri:
  - `ALLOWED_ORIGINS` (varsayılan `https://huseyinozn.github.io,null`)
  - `MAX_UPLOAD_MB` 60
  - `SLICE_TIMEOUT` 780
  - `PARALLEL_JOBS` 2
- Kod yalnızca standart kütüphane, `linuxserver/orcaslicer:latest` imajının üstünde çalışıyor (OrcaSlicer 2.4.2 CLI, `/opt/orcaslicer/AppRun`).

**Yazıcı profilleri (`server.py` içindeki PRINTERS):**
- **a1:** Bambu Lab A1 0.4 / 0.20mm Standard @BBL A1 / Bambu PLA Basic @BBL A1.
  - Bütün filamentler tek nozula atanıyor (`map single`).
  - Kule Y konumu 165 (yoksa -102 "yatak dışı" hatası).
- **u1:** Snapmaker'ın **kendi OrcaSlicer fork'undaki** profiller (github.com/Snapmaker/OrcaSlicer, commit bac6fd5): `slicer-server/profiles/Snapmaker Orca/`.
  - Stok OrcaSlicer'daki U1 profili kuleyi yarı yarıya hesaplıyordu.
  - Başlangıç G-code'undaki `chamber_cooling_mode` değişkeni stok Orca'da yok, `1` ile değiştiriliyor (`gcode_vars`).
- **quadro:** CoPrintSlicer'daki Co Print profilleri (`profiles/Co Print/`).
  - Profilde takım değişimi süresi 0, o yüzden değişim başına +1.5 s ekleniyor.

**OrcaSlicer CLI tuzakları (hepsi çözüldü, tekrar bozma):**
- Presetler düzleştirilmeli (inherits zinciri çözülür): `flatten.py`.
- `--load-filament-ids` segfault veriyor; elle yazılmış 3MF de çöküyor. Yalnızca Orca'nın kendi dışa aktardığı 3MF'ler kullanılıyor.
- `filament_map` yalnızca 3MF plate metadata'sından okunuyor: `patch3mf.py`, Manual eşleşme. A1 için "1 1 1 1".
- 3MF içindeki `project_settings.config` hedef yazıcının tam şablonuyla değiştiriliyor (`tpl/{yazıcı}_{renk sayısı}.json`); yalnızca dosyanın `filament_colour` değeri korunuyor.
- Filament dosyalarının adları farklı olmalı (`... #1..#4`). Yoksa Orca dört filamenti tek sanıp prime tower'ı kapatıyor.
- STL önce `--export-3mf` ile 3MF'e çevrilip tek renk dilimleniyor.
- `--arrange 1` her yazıcının tablasına yerleştiriyor.

**İstatistik (`stats.py`):**
- Model ve kule `;TYPE:` / `; FEATURE:` işaretlerinden sayılıyor.
- Flush = Orca'nın toplam gramı − model − kule.
- Takım değiştiricilerde (U1, Quadro) atık çukuru olmadığı için kalan miktar kuleye ekleniyor.

**Toolpath (`toolpath.py`):**
- Çıktı biçimi: `{"v":1,"layers":[[z,[[tool,kind,x0,y0,dx1,dy1,...],...]],...]}`.
- `kind`: 0 model, 1 prime tower, 2 dış duvar.
- Koordinatlar 0.1 mm birimiyle, her nokta bir öncekine göre fark olarak tutuluyor; yollar RDP ile 0.08 mm toleransla inceltiliyor.
- Kardan adamda 500 katman, 460 bin nokta: 2.7 MB JSON, sıkışınca 0.8 MB.

**Doğrulanmış sonuçlar:**

| Model / yazıcı | Süre | Model | Kule | Flush |
|---|---|---|---|---|
| 4 küp × 4 renk, A1 | 11 sa 46 dk | 20.7 g | 29.9 g | 56.5 g |
| 4 küp × 4 renk, Quadro | 1 sa 45 dk | 19.4 g | 21.8 g | 0 |
| Kardan adam, Quadro (Co Print Slicer: toplam 91.4 g) | 4 sa 35 dk | 67.6 g | 23.5 g | — |
| Kardan adam, U1 (Snapmaker Orca: toplam 111.6 g, süre 4 sa 52 dk) | 4 sa 50 dk | 76.1 g | 30.1 g | — |

- Kardan adam U1'de bizim toplamımız 106.2 g. Kalan ~5 g fark, Snapmaker fork'una özel kule özelliklerinden (stamping, kule ütüleme, ek kule kaburgası) geliyor; stok Orca bunları uygulayamıyor.
- Birebir sonuç için sunucuda Snapmaker Orca'yı kaynaktan derlemek gerekir. Kullanıcıya sunuldu, karar bekleniyor.
- Kardan adam dilimlemesi 4 CPU ile yaklaşık 1.5–3 dakika sürüyor.

## 6. Ask worker (Cloudflare)

- Workers Builds GitHub'dan otomatik kuruyor: kök dizin `quadro3d/ask-worker`, komut `npx wrangler deploy`.
- `ANTHROPIC_API_KEY` Cloudflare panelinde secret olarak duruyor.
- Bilgi tabanı: `guide.md`, Quadro modüllerinin kaynağı ve config; `build-knowledge.py` ile `knowledge.md` üretiliyor. Depo public; bilgi tabanının açık olması kullanıcının kararı.
- Kullanıcı kararları:
  - Cevaplarda "Co Print mi, Klipper mı" ayrımı yapılmaz; hepsi "Quadro yazılımı".
  - Bed mesh T0'ın `load_cell_probe`'u ile alınır.
  - `bed_pin` ayrı bir problar, bed pin kalibrasyonunda kullanılır.

## 7. Yayınlama adımları

```sh
# önizleme
cd Anatomy-deneme/quadro3d && ./build-pages.sh ../../quadro-3d/preview
cd ../../quadro-3d && git add -A preview && git commit -m "Preview: ..." && git push origin main

# ana site (kullanıcı onayından sonra)
cd Anatomy-deneme/quadro3d && ./build-pages.sh ../../quadro-3d
cd ../../quadro-3d && git add -A index.html klipper.js jinja.js screen.js qs printer-config.json && git commit && git push origin main
```

- **Artifact:** `quadro3d/index.html` doğrudan yayınlanıyor (MODEL_URL `quadro-glb.txt` olarak kalır).
  - Yanında gidecek dosyalar: `klipper.js`, `jinja.js`, `screen.js`, `printer-config.json`, `logo.svg`, `screen.png` ve `qs/*`.
  - `quadro-glb.txt` artifact'ta zaten var, yeniden göndermeye gerek yok.
  - Yeni bir oturumda önce artifact'ı `read` et, sonra `url` ile yayınla.
- **Dilimleme servisi:** `master`'a push etmek yeterli (Cloud Build kurar).
  - Kurulduğunu doğrulamak için, değişen bir alanı döngüyle yoklayan bir kontrol arka planda çalıştırılabilir.

## 8. Fotoğraflara göre model kararları (28–29 Ekim)

**Yapılanlar:**
- PTFE'ler makara tutucudaki beyaz rakorlara (`Quadro-z-inject-plastic-13`) ön yüzlerinden giriyor. Konumlar CAD mesh'inden ölçüldü: x 328.3 / 268.3 / −271.5 / −211.4, y 191, z 355.6.
- X yan kapaklarında pirinç rakor yerine siyah lastik geçit var.
- Kafa ışığı kafanın kendi şeffaf parçası (`Quadro-x-inject-plastic-16`), takılı filamentin renginde yanıyor.
  - GLTFLoader tekrar eden adlara `_1`, `_2` eklediği için eşleşme `/x-inject-plastic-16(_\d+)?$/`.
- Alüminyum biraz daha açık eloksal tonu.

**Kullanıcının "kalsın" dedikleri (değiştirme):**
- Beyaz makara göbeği.
- Makaraların yeri: solda mavi üstte / kırmızı altta, sağda sarı üstte / yeşil altta.
- Beyaz filament kılavuz parçaları.
- PTFE'nin şeffaf boru içinde renkli filament olarak çizilmesi.
- Klipsler gerekmiyor; kablo yayları isteğe bağlı.
- Aktif kafanın grileşmesi.
- Bej PEI plaka.
- Üst kirişin köşeleri.

**Açık soru:** Makara yanakları sitede bej/karton, gerçekte siyah. Kullanıcı bu maddeye cevap vermedi.

## 9. Bekleyen ve ileride konuşulacak işler

- **Sıradaki iş:** kullanıcı **arayüz düzenlemeleri** isteyecek.
- U1 için birebir sonuç (Snapmaker Orca'yı derlemek): karar bekleniyor.
- claude.ai artifact'ında dilimleme denenmedi. O sayfanın origin'i `ALLOWED_ORIGINS`'te yoksa servis reddeder; gerekirse eklenir.
- Ertelenen işler (kullanıcı ekibiyle takvim belirleyince dönecek):
  - mobil uygulama
  - model kütüphanesi
  - mikrofon / hoparlör ve sesli komut
  - ek kameralar
  - özel alan adı ve Co Print sitesi
  - asistana fiyat vb. ürün bilgileri eklemek
- Bilinen sınırlar:
  - Simülasyon hareketleri sabit hızda oynatıyor.
  - Dilimlenen dosyalar sayfa yenilenince kayboluyor.
  - Cloud Run birden fazla instance açarsa G-code indirme başka instance'a düşüp 404 verebilir; çözüm modeli tekrar dilimlemek.
  - A1 STL'de "part" toplamdan biraz fazla görünebiliyor (önemsiz).
- Docker taban imajı `latest`; ileride sürüme sabitlemek iyi olur.

## 10. Bu ortamda test ipuçları

- Docker: `dockerd` elle başlatılır; `run_in_background` ile çalıştır, yoksa kabuk kapanınca ölür.
  - Yerel servis: `docker build -t quadro-slicer quadro3d/slicer-server`
  - Çalıştırma: `docker run -d --name qs --cpus 4 --memory 8g -p 8091:8080 -e ALLOWED_ORIGINS='*' quadro-slicer`
- Tarayıcı testi: Playwright + önceden kurulu Chromium.
  - localhost'a fetch için `--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests` bayrağı gerekiyor.
  - Headless Chrome CPU'da çizdiği için ağır sahnelerde ekran görüntüsü dakikalar sürebilir.
  - Kamera için yalnızca test kopyasına `window.__look(pos, target)` kancası eklenebilir (kaynakta yok).
- CAD modelinden ölçü almak: glb'nin JSON'u okunur, pozisyonlar quantize (int16/32767) olduğu için önce çözülmesi gerekir.
- Test modelleri: 4 renkli küp 3MF ve kullanıcının "Snowman Test Model-2.3mf" dosyası (21 MB, boyanmış, 4 renk; depoda yok, kullanıcıda var).
