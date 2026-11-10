# Kickstarter Live

Kickstarter kampanyasının toplanan tutarını ve backer sayısını canlı gösteren sayfa. Yeni bir backer gelince bildirim sesi (`public/sounds/backer.mp3`) çalar, ekranda "+1 backer · +$99" bildirimi çıkar.

## Çalıştırma

Bilgisayarında Node.js 18 veya üstü kurulu olmalı. Başka bir şey kurmana gerek yok.

```bash
cd kickstarter-live
node server.js
```

Sonra tarayıcıda **http://localhost:3000** adresini aç ve **Başlat**'a tıkla. Tarayıcılar sesi ancak bir tıklamadan sonra çalıyor.

- Test için: **http://localhost:3000/?demo=1** adresi birkaç saniyede bir sahte backer üretir. Sesi ve animasyonu böyle deneyebilirsin.
- **▶ Sesi dene** butonu sesi bir kez çalar.

## TV'de lansmana kadar açık bırakmak

1. Sayfayı aç, **Başlat**'a ve **⛶ Tam ekran**'a bas. Sonra dokunma. Lansmana kadar geri sayım gösterir.
2. Kickstarter'da kampanya açılınca (10 saniye içinde) sayfa kendiliğinden canlı ekrana geçer. "🚀 Kampanya canlı!" bildirimi çıkar ve o ana kadar gelen backer'lar için ses çalar.
3. Geri sayım bittiği halde kampanya henüz açılmadıysa "Birazdan canlı…" yazar ve beklemeye devam eder.
4. Bilgisayarın **uyku modunu kapat**. Sayfayı **yenileme**: yenilersen tarayıcı sesi tekrar kilitler ve yeniden **Başlat**'a basman gerekir.

Ses TV'den gelsin istiyorsan en kolay yol laptop'u HDMI ile bağlamak. Smart TV tarayıcısı kullanacaksan sunucu çalışırken ekranda yazan `Aynı ağdan (TV)` adresini TV'de aç. Ama TV tarayıcıları ses ve tam ekran konusunda sorun çıkarabilir.

## Ayarlar

`public/config.js` dosyasını düzenle. Ya da sayfadaki **⚙ Ayarlar** menüsünü kullan:

| alan | açıklama |
|---|---|
| `project` | Kickstarter linki ya da `kullanici/proje` kısmı |
| `nativeGoal`, `nativeCurrency` | Kickstarter'daki gerçek hedef ve para birimi (örn. 7850, £) |
| `goal`, `currency` | ekranda gösterilen hedef (örn. 10000, $). Tutarlar `goal / nativeGoal` kuruyla çevrilir |
| `launchAt` | lansman zamanı. Geri sayım buna göre işler |
| `endAt` | bitiş zamanı. Doldurulursa "days to go" görünür |
| `pollSeconds` | kaç saniyede bir kontrol edileceği (varsayılan 10) |

## Nasıl çalışıyor

Kickstarter her proje için herkese açık bir adres yayınlıyor: `https://www.kickstarter.com/projects/<kullanici>/<proje>/stats.json`. Bu adres `backers_count` ve `pledged` değerlerini veriyor. Tarayıcı bu adresi doğrudan okuyamadığı için (CORS), `server.js` aradan geçiriyor. Sayfa her 10 saniyede bir kontrol ediyor. Backer sayısı ya da tutar artınca ses çalıyor.

Notlar:
- Bu resmi bir API değil. Kickstarter'ın kendi sayfası da bu adresi kullanıyor, ama ileride değişebilir.
- Kickstarter verisi yaklaşık 5 saniye önbellekte tutuluyor. Bu yüzden ses birkaç saniye gecikmeyle gelebilir.
- Aynı anda birden fazla backer gelirse ses en fazla `maxChimes` (5) kez çalar.
- Ekran açık kalsın diye sayfa uyku kilidi (Wake Lock) istiyor. Ekran/TV'de **⛶ Tam ekran** ile kullanabilirsin.
