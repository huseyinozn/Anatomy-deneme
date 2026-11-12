// ── Kampanya ayarları ── sadece burayı düzenle ──────────────────────────────
window.CAMPAIGN = {
  // Kickstarter linkindeki "kullanici/proje" kısmı (tam link de yapıştırılabilir).
  project: "coprint3d/co-print-quadro-independent-4-toolhead-color-3d-printer",

  title: "Co Print Quadro",

  // Kickstarter'daki gerçek hedef ve para birimi (stats.json bu birimde döner).
  nativeGoal: 7850,
  nativeCurrency: "£",

  // Ekranda gösterilen hedef ve para birimi. Kur = goal / nativeGoal
  // (7850 £ = 10.000 $  ->  1 £ ≈ 1.274 $). Çeviri istemiyorsan goal'u nativeGoal ile aynı yap.
  goal: 10000,
  currency: "$",

  // Başlangıç / bitiş (Türkiye saati +03:00). 25 gün: 12 Kasım 19:00 → 7 Aralık 19:00
  launchAt: "2026-11-12T19:00:00+03:00",
  endAt: "2026-12-07T19:00:00+03:00",

  pollSeconds: 5,       // Kickstarter'ı kaç saniyede bir kontrol etsin
  maxChimes: 8,         // tek kontrolde çok backer gelirse en fazla kaç kez çalsın
};
