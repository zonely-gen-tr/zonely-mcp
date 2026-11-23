# Zonely MCP

Zonely panelini, tema dosyalarını ve yerel içerik araçlarını Codex'ten kullanın. MCP bilgisayarınızda çalışır. Panel işlemlerini sessizce arka planda yürütür. Dağıtım paketi bağlantısız başlar. Her kullanıcı kendi site adresini tanımlar ve sitenin panelinde kendi hesabıyla oturum açar.

## Kurulum

Codex’te bu klasörü çalışma alanı olarak açın ve **“Zonely MCP’yi kur. Sitem https://siteniz.example, dil Türkçe.”** yazın. Codex [kurulum talimatını](AGENTS.md) kullanarak MCP bağlantısını hazırlar. GitHub üzerinden kullanacaksanız güvenilir Zonely MCP depo adresini verip önce depoyu indirmesini isteyin.

## Elle kurulum

Node.js 24 veya üzeriyle bu klasörde çalıştırın.

```sh
npm install -g .
zonely-mcp install-browser
zonely-mcp codex-config
```

Çalışan bir siteniz varsa `zonely-mcp setup` ile adresini ve rehber dilini bağlayın. `zonely-mcp languages` Zonely'nin 19 rehber dilini listeler. Otomatik kurulum için `zonely-mcp setup --url https://siteniz.example --lang tr` kullanabilirsiniz.

`codex-config` komutunun çıktısını Codex'in `~/.codex/config.toml` dosyasına ekleyin, ardından Codex'i yeniden başlatın. Yeni sohbette “Zonely panelime bağlan. Duyurularımı listele.” yazabilirsiniz. Oturum gerekiyorsa “Giriş ekranını aç” yazıp sitenizde oturum açın. [Codex MCP yapılandırması](https://learn.chatgpt.com/docs/extend/mcp?surface=app)

Başarılı girişin ardından giriş ekranı kapanır ve sonraki komutlar oturumu arka planda kullanır. Duyuru ve destek listeleri için `zonely_panel_records` kullanılır. “McpTest kullanıcısına 500 kredi ekle” gibi bir işlemde `zonely_member_credit` önce tam kullanıcı adını ve mevcut bakiyeyi doğrular. Uygulama, önizlemedeki kullanıcı kimliğini ister ve ardından bakiyeyi yeniden okur.

Destekleyen Zonely kurulumlarında aynı araç `direction=debit` ile kredi düşebilir. Uygulama için önizlemedeki kullanıcı kimliği ve bakiye gerekir. Bakiye değiştiyse yeni önizleme gerekir.

## Başlangıç ve yayına hazırlık

Yeni bir siteniz için bağlayacağınız çalışan bir adresiniz bulunmasa da MCP'yi istemcinize kaydedip başlayabilirsiniz. Örneğin **“Bana ait oyun.example.com alan adı için 0 TL deneme lisansını önizle ve DNS adımına kadar ilerle.”** yazın. Kendi hesabınızda oturum açın ve önizlemedeki alan adı ile sıfır tutarı onaylayın. MCP, lisans kaydını hesabınızdan doğrular ve ilgili ürünün DNS kılavuzuna yönlendirir. DNS kayıtlarını kendi sağlayıcınızda yönetirsiniz. Ardından aynı hesapta barındırmayı başlatabilir ve site açılınca ilk yönetici kurulumunu tamamlayabilirsiniz.

`zonely_onboarding` resmi başlangıç rehberlerini 19 dilde ve ilgili panel iş akışlarıyla birlikte sunar. Aktif site yönetimi için siteniz açıldıktan sonra `setup` ile adresini bağlayabilirsiniz.

## Tema taslağı oluşturma

Bağlı sitenizde **“Benim için yeni bir özel tema taslağı oluştur ve üst menü şablonunu düzenle.”** yazabilirsiniz. Temalar paneli, Default tabanlı yeni bir taslak oluşturur. MCP, size ait özel ve etkin olmayan temanın düzenlenebilir `Pages` ve `Navigations` şablonlarını okuyabilir. Değişiklik kaydedilirken dosya sürümü denetlenir ve kaydedilen içerik tekrar okunur.

Uygun temaları topluluğa açmak için Temalar ekranında **Düzenle → Herkese açık** seçeneğini kullanın. [Temalar rehberi](https://docs.zonely.gen.tr/guides/choosing-a-theme)

## Other MCP clients

Run `node src/cli.mjs mcp-config` after installing the dependencies. Merge the generated `mcpServers.zonely` entry into the client configuration. The entry uses absolute paths. [Claude Desktop local setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

For Claude Code, register the generated JSON with `claude mcp add-json zonely '<server-entry-json>'`. Pass the value of `mcpServers.zonely` as the server entry. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

The package uses local stdio. The Claude web app uses remote connectors.

## Görsel yükleme

Paneldeki **Resim Yönetimi** akışı dosyayı kaydeder ve herkese açık bağlantıyı `image.url` olarak doğrular. Var olan görselin bağlantısı için `zonely_panel_image_link` aracına slug değerini verin.

## Panel API'si ve SFTP

Paneldeki tarayıcı işlemleri için site oturumu yeterlidir. Panel API'si gerekiyorsa site API anahtarını `ZONELY_SITE_API_KEY` ortam değişkenine koyup `zonely-mcp setup --api` çalıştırın. Windows'ta kurulum anahtarı DPAPI ile şifreler. macOS ve Linux'ta değişkeni Codex'i başlatan ortamda sağlayın. Profil ve tarayıcı verileri `~/.zonely-mcp` altında, site oturumları alan adına göre ayrı tutulur.

Panel oturumunuz açıksa `zonely_sftp_prepare` ile **Şablonlar → SFTP** üzerinden aktif temaya erişebilirsiniz. Bağlantı bilgileri oturum belleğinde tutulur. İlk bağlantıda gözlenen sunucu anahtarı kaydedilir ve sonraki bağlantılarda eşleşme doğrulanır.

API ile SFTP hazırlamak için aynı kurulumda `--sftp-fingerprint` ile hosting sağlayıcınızdan aldığınız SHA256 parmak izini girin. Gerekirse `--sftp-host` ve `--sftp-port` da verebilirsiniz. Codex'te `zonely_sftp_prepare` erişimi hazırlar. MCP mevcut tema `.tpl` dosyalarına doğrudan yazar, önceki sürümü yerelde yedekler ve kaydı geri okur. Dosya küçültme, SFTP sunucusunun açık dosyada boyut değiştirmeye izin vermesini gerektirir. Diğer dosyaları kaydetme ve yeni dosya oluşturma, SFTP profilinin dosya oluşturma ve yeniden adlandırma izinlerine bağlıdır.

## Dil ve sürüm

Codex, kurulumda seçtiğiniz dili ve Zonely dokümantasyonunu kullanır. “Zonely rehber dilini İngilizce yap” gibi bir istek, açık MCP oturumundaki dili değiştirir. Kalıcı seçim için `setup` komutunu aynı site ve yeni dil ile yeniden çalıştırın.

`1.0.2` ve sonrası, bir oturumdaki ilk MCP işlemi sırasında resmî GitHub sürümünü arka planda kontrol eder. Doğrulanan güncelleme sonraki MCP bağlantısında devreye girer. Devam eden işler ve sohbet aynı oturumda sürer.

Önceki sürümlerden geçerken güncel ZIP’i bir kez kurun. Kurulum dizini değişirse MCP istemcisindeki kayıt yolunu güncelleyin. İsteğe bağlı olarak istemci ortamında `ZONELY_AUTO_UPDATE=0` ayarıyla otomatik güncelleme kapatılabilir. `zonely-mcp check-update` ile elle kontrol yapılabilir.

Argos ve PaddleOCR isteğe bağlıdır. Python 3.12 ortamına `python -m pip install -r requirements.txt` ile bağımlılıkları kurup `python scripts/setup-engine.py --install-models --install-ocr` ile modelleri hazırlayabilirsiniz. `ZONELY_PYTHON` ile o ortamın Python yolunu seçin. Rehber dilleri, yerelde kurulu çeviri ve OCR modellerinden bağımsızdır.

## Panel kapsamı

Paket Zonely'nin 150 rehberini, kayıtlı panel akışlarını ve mevcut API kataloğunu kullanır. Bir işlemin listelenmesi kayıt testinin geçtiği anlamına gelmez. Örneğin Google sağlayıcı anahtarının kaydı ve geri okunması doğrulandı. Google ile giriş, sağlayıcı anahtarlarıyla ayrıca doğrulanmalıdır. Sitenin sürümü, kurulu eklentiler ve kullanıcının yetkileri kullanılabilecek işlemleri belirler.
