import fs from 'node:fs';
import {documentationGuide,documentationLanguage} from './documentation.mjs';

const start='/getting-started/';
const g='/guides/';
const step=(id,kind,tr,en,guide,workflowId,tool)=>({id,kind,tr,en,...(guide?{guide}:{}),...(workflowId?{workflowId}:{}),...(tool?{tool}:{})});
export const onboardingPlans={
  '/index':[
    step('install','manual','Hesap, lisans ve kurulum','Account, license and installation',start+'installation'),
    step('domain','manual','Alan adı, DNS ve SSL','Domain, DNS and SSL',start+'domain-and-dns'),
    step('first-admin','manual','İlk yönetici hesabını oluştur','Create the first administrator',start+'initial-site-setup'),
    step('launch','panel','Yayına hazırlık listesini aç','Open the launch checklist',start+'prepare-for-launch'),
    step('products','panel','Ürün ve sipariş rehberlerini aç','Open product and order guides',g+'products'),
    step('payments','panel','Ödeme sağlayıcılarının gereksinimlerini incele','Review payment provider requirements','/payments/overview'),
    step('design','panel','Sayfa tasarımı rehberini aç','Open the page design guide',g+'page-builder'),
    step('integrations','manual','Oyun ve servis bağlantılarını incele','Review game and service integrations','/integrations/overview'),
    step('troubleshoot','manual','Sorun çözümü rehberlerini aç','Open troubleshooting guides','/troubleshooting/overview'),
  ],
  [start+'installation']:[
    step('account','manual','Zonely hesabını oluştur veya giriş yap','Register or sign in to your Zonely account'),
    step('trial','manual','Deneme lisansını alan adına ekle','Add a trial license for your domain',start+'licenses'),
    step('install','manual','Lisanslarım ekranından Kurulum Yap','Start installation from My Licenses',start+'licenses'),
    step('connect-domain','manual','Alan adını bağla ve kurulumu tamamla','Connect the domain and finish installation',start+'domain-and-dns'),
    step('wizard','manual','İlk site kurulumunu tamamla','Complete the initial site wizard',start+'initial-site-setup'),
  ],
  [start+'domain-providers']:[
    step('availability','manual','Alan adı ve uzantının uygunluğunu kontrol et','Check domain and extension availability'),
    step('compare','manual','İlk yıl, yenileme ve transfer ücretlerini karşılaştır','Compare registration, renewal and transfer costs'),
    step('ownership','manual','Kendi hesabınla satın al, e-postayı doğrula','Register in your own account and verify email'),
    step('dns','manual','Cloudflare nameserver bağlantısını hazırla','Prepare Cloudflare nameserver delegation',start+'domain-and-dns'),
  ],
  [start+'domain-and-dns']:[
    step('license-domain','manual','Lisans alan adını doğrula','Verify the licensed domain',start+'licenses'),
    step('nameservers','manual','Cloudflare nameserver adreslerini kayıt kuruluşuna bağla','Delegate nameservers to Cloudflare'),
    step('cname','manual','@ ve www için proxied CNAME hedefi premium.zonely.gen.tr; diğer hizmetlerin kayıtlarını koru','Set proxied CNAME @ and www to premium.zonely.gen.tr; preserve other service records'),
    step('ssl','manual','SSL/TLS Full ve Universal SSL Active durumunu kontrol et','Check SSL/TLS Full and Universal SSL Active'),
    step('https','manual','Ana adresi ve www adresini HTTPS ile aç; bağlantı yardımında kurulumu tamamla','Open apex and www over HTTPS; finish setup in the connection assistant'),
  ],
  [start+'licenses']:[
    step('install','manual','Lisanslarım üzerinden kurulumu başlat','Start installation from My Licenses',start+'installation'),
    step('domain-change','manual','Gerekiyorsa lisans alan adını değiştir ve DNS ayarla','If needed, change the licensed domain and configure DNS',start+'domain-and-dns'),
    step('db-info','manual','Veritabanı bilgilerini hesap ekranında incele','View database credentials in the account portal'),
    step('db-download','manual','Veritabanı yedeğini indir ve güvenli sakla','Download and securely store the database backup'),
    step('reset','destructive-manual','Kurulumu sıfırlamak geri alınamaz; önce yedek al','Resetting installation is irreversible; back up first'),
    step('diagnose','manual','Yarım kalan kurulumu veya bağlantı yardımını kontrol et','Inspect incomplete installation or the connection assistant'),
  ],
  [start+'initial-site-setup']:[
    step('language','manual','Kurulum dilini seç','Select the installation language'),
    step('site','manual','Site ve ekip bilgilerini gir; hazırlıkta bakım modunu açık tut','Enter site and team information; keep maintenance enabled while preparing'),
    step('industry','manual','Pazarlama sistemi ve oyun/sektör seç','Select marketing system and game or industry'),
    step('admin','manual','İlk yetkili hesabını sektöre uygun giriş/bağlantıyla oluştur','Create the first administrator using the sector-specific login or connection'),
    step('contact','manual','Sunucu adresi ve iletişim bilgilerini gir','Enter server and contact details'),
    step('finish','manual','Bilgileri kontrol et, kurulumu tamamla ve panele giriş yap','Review details, finish installation and sign in to the panel'),
    step('launch','panel','Yayına hazırlık listesinden devam et','Continue with the launch checklist',start+'prepare-for-launch'),
  ],
  [start+'prepare-for-launch']:[
    step('logo','panel','Logoyu yükle ve görünümü kontrol et','Upload the logo and check its appearance',g+'page-builder/logo','form:main.general.settings:settingsForm'),
    step('theme','panel','Temayı seç veya mevcut temayı doğrula','Select or verify the existing theme',g+'choosing-a-theme'),
    step('color','panel','Tema renklerini kaydet ve okunabilirliği kontrol et','Save theme colors and check readability',g+'page-builder/colors','form:main.themes:pageBuilderForm'),
    step('payment','panel','Ödeme yöntemi ekle; sağlayıcı hesabını ayrıca doğrula','Add a payment method; independently verify the provider account',g+'payment-gateways','form:main.payments:paysForm'),
    step('server','panel','Oyun içi pazarlama kullanılıyorsa sunucu kaydı ve teslimatı kontrol et','If using in-game marketing, configure the server and verify delivery',g+'servers','form:main.servers:serversForm'),
    step('category','panel','İlk ürün kategorisini ekle','Add the first product category',g+'products','form:product_categories:categoryAddForm'),
    step('product','panel','İlk ürünü ekle; stok, teslimat ve müşteri görünümünü kontrol et','Add the first product; verify stock, delivery and customer view',g+'products','form:main.shop:productsForm'),
    step('support','panel','İlk destek kategorisini ekle','Add the first support category',g+'live-support','form:support_categories:categoryAddForm'),
    step('announcement','panel','İlk duyuruyu kaydet ve müşteri görünümünü kontrol et','Save the first announcement and check the customer view',g+'announcements','form:main.news:broadcastsForm'),
    step('maintenance','panel','Hazırlık bitince bakım modunu kapat','Disable maintenance mode when preparations are complete',g+'system-settings','form:main.settings:settingsForm'),
  ],
};

export function onboardingPlan(panel,{guidePath='/index',language=panel.documentationLanguage,textOffset=0}={}){
  language=documentationLanguage(language);
  const catalog=panel.documentWorkflows;
  const guides=catalog?.guides??[];
  const guide=guides.find(item=>item.url===guidePath||documentationGuide(item,language).url===guidePath);
  if(!guide||!Object.hasOwn(onboardingPlans,guide.url)||!guide.onboarding)throw Error('Select an onboarding guidePath from zonely_panel_workflows');
  const localized=documentationGuide(guide,language);
  const labelLanguage=language==='tr'?'tr':'en';
  const steps=onboardingPlans[guide.url].map(({id,kind,tr,en,guide:related,workflowId,tool})=>{
    const target=guides.find(item=>item.url===related);
    const targetUrl=related?documentationGuide(target??{url:related},language).documentationUrl:undefined;
    const available=workflowId&&Object.hasOwn(panel.recipes,workflowId);
    return {id,kind,label:labelLanguage==='tr'?tr:en,verification:'not-checked',
      ...(target?{guidePath:target.url,documentationUrl:targetUrl}:targetUrl?{documentationUrl:targetUrl}:{}),
      ...(available?{workflowId,tool:'zonely_panel_run'}:tool?{tool}:{})};
  });
  const documents=JSON.parse(fs.readFileSync(new URL('../data/onboarding-documents.json',import.meta.url),'utf8'));
  const document=documents[guide.url]?.[language];
  if(!document)throw Error('Bundled onboarding guide language unavailable');
  const content=document.text.slice(textOffset,textOffset+5000);
  const configured=Boolean(panel.profile?.panel?.url??panel.profile?.api?.url);
  return {guidePath:guide.url,title:localized.title,documentationUrl:localized.documentationUrl,language,labelLanguage,
    configured,siteOrigin:configured?panel.origin():null,mode:'read-only-plan',verification:'not-checked',
    steps,document:{source:'bundled-official-source',language,sha256:document.sha256,offset:textOffset,
      nextOffset:textOffset+content.length<document.text.length?textOffset+content.length:null,text:content},
    localizedDocumentTool:'zonely_panel_workflows',manualStepsRequireUserAccount:true};
}
