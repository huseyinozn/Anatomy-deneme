// ── Kampanya ayarları ── sadece burayı düzenle ──────────────────────────────
window.CAMPAIGN = {
  // Kickstarter linkindeki "kullanici/proje" kısmı.
  // Örn: https://www.kickstarter.com/projects/coprint/quadro-3d  ->  "coprint/quadro-3d"
  // (Sayfadaki ⚙ menüsünden de değiştirilebilir.)
  project: "",

  title: "Kickstarter Live",

  goal: 10000,          // hedef tutar
  currency: "$",        // para birimi simgesi

  // Başlangıç / bitiş (Türkiye saati +03:00). Bitiş bilinmiyorsa null bırak.
  launchAt: "2026-11-12T17:00:00+03:00",
  endAt: null,          // örn: "2026-12-12T17:00:00+03:00"

  pollSeconds: 10,      // Kickstarter'ı kaç saniyede bir kontrol etsin
  maxChimes: 5,         // aynı anda çok backer gelirse en fazla kaç kez çalsın
};
