"""Lightweight technology detection from HTML, script URLs, response headers, cookies and DNS names.

Local pattern table only (no paid detection API). A detected analytics tag says nothing about how
much traffic the site gets; it is one more signal about how the site is operated.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

Category = Literal[
    "cms", "ecommerce", "framework", "cdn", "hosting", "analytics", "advertising", "marketing", "payments", "server", "other"
]


@dataclass(frozen=True)
class Sig:
    name: str
    category: Category
    html: tuple[str, ...] = ()  # regexes over the raw HTML (first 300 KB)
    scripts: tuple[str, ...] = ()  # regexes over external script URLs
    headers: tuple[tuple[str, str], ...] = ()  # (header name, regex over value)
    cookies: tuple[str, ...] = ()  # regexes over Set-Cookie names
    generator: tuple[str, ...] = ()  # regexes over <meta name=generator>
    dns: tuple[str, ...] = ()  # regexes over CNAME / NS names
    implies: tuple[str, ...] = ()


SIGNATURES: tuple[Sig, ...] = (
    # ---- CMS
    Sig("WordPress", "cms", html=(r"/wp-content/", r"/wp-includes/", r"wp-json"), generator=(r"^wordpress",), implies=("PHP",)),
    Sig(
        "Drupal",
        "cms",
        html=(r"/sites/default/files/", r"drupal-settings-json", r"data-drupal-"),
        generator=(r"^drupal",),
        headers=(("x-generator", r"drupal"), ("x-drupal-cache", r".")),
        implies=("PHP",),
    ),
    Sig("Joomla", "cms", html=(r"/media/jui/", r"/components/com_", r"joomla"), generator=(r"^joomla",), implies=("PHP",)),
    Sig("Ghost", "cms", generator=(r"^ghost",), html=(r"ghost-sdk", r"/ghost/api/")),
    Sig(
        "Webflow",
        "cms",
        html=(r"data-wf-site=", r"data-wf-page="),
        generator=(r"^webflow",),
        scripts=(r"assets\.website-files\.com", r"webflow\.js"),
    ),
    Sig(
        "Wix",
        "cms",
        html=(r"static\.parastorage\.com", r"wix\.com", r"wixstatic\.com"),
        generator=(r"wix\.com",),
        headers=(("x-wix-request-id", r"."),),
    ),
    Sig(
        "Squarespace",
        "cms",
        html=(r"static1\.squarespace\.com", r"squarespace\.com/universal"),
        generator=(r"^squarespace",),
        headers=(("server", r"squarespace"),),
    ),
    Sig("HubSpot CMS", "cms", html=(r"hs-sites\.com", r"hubspot\.net/hub/"), generator=(r"^hubspot",), implies=("HubSpot",)),
    Sig("Duda", "cms", html=(r"cdn-cms\.f-static\.", r"duda_"), generator=(r"^duda",)),
    Sig("Weebly", "cms", html=(r"weebly\.com", r"editmysite\.com"), generator=(r"^weebly",)),
    Sig("GoDaddy Website Builder", "cms", html=(r"img1\.wsimg\.com", r"godaddy"), generator=(r"starfield|godaddy",)),
    Sig("Blogger", "cms", html=(r"blogger\.com/", r"blogspot\.com"), generator=(r"^blogger",)),
    Sig("Framer", "cms", html=(r"framerusercontent\.com",), generator=(r"^framer",)),
    Sig("Typo3", "cms", html=(r"typo3conf", r"typo3temp"), generator=(r"^typo3",)),
    Sig("Sitecore", "cms", html=(r"/sitecore/", r"sc_site="), implies=("ASP.NET",)),
    Sig("Adobe Experience Manager", "cms", html=(r"/etc\.clientlibs/", r"/content/dam/")),
    Sig("Contentful", "cms", html=(r"ctfassets\.net", r"contentful")),
    Sig("Craft CMS", "cms", generator=(r"^craft",), headers=(("x-powered-by", r"craft cms"),)),
    # ---- ecommerce
    Sig(
        "Shopify",
        "ecommerce",
        html=(r"cdn\.shopify\.com", r"Shopify\.theme", r"shopify-section"),
        headers=(("x-shopify-stage", r"."), ("x-shopid", r".")),
        scripts=(r"cdn\.shopify\.com",),
        dns=(r"shops\.myshopify\.com",),
    ),
    Sig(
        "WooCommerce",
        "ecommerce",
        html=(r"woocommerce", r"/wp-content/plugins/woocommerce/"),
        generator=(r"woocommerce",),
        implies=("WordPress",),
    ),
    Sig(
        "Magento",
        "ecommerce",
        html=(r"/static/version\d+/", r"Magento_", r"mage/cookies", r"/static/frontend/"),
        cookies=(r"^mage-", r"^form_key$"),
        headers=(("x-magento-", r"."),),
    ),
    Sig("BigCommerce", "ecommerce", html=(r"cdn\d*\.bigcommerce\.com", r"bigcommerce"), headers=(("x-bc-", r"."),)),
    Sig("PrestaShop", "ecommerce", html=(r"prestashop", r"/modules/ps_"), generator=(r"^prestashop",), cookies=(r"^PrestaShop-",)),
    Sig("OpenCart", "ecommerce", html=(r"catalog/view/theme", r"route=product/"), cookies=(r"^OCSESSID$",)),
    Sig(
        "Salesforce Commerce Cloud",
        "ecommerce",
        html=(r"demandware\.static", r"/on/demandware\.store/"),
        cookies=(r"^dwanonymous_", r"^dwsid$"),
    ),
    Sig("Wix Stores", "ecommerce", html=(r"wixstores", r"wix-stores"), implies=("Wix",)),
    Sig("Squarespace Commerce", "ecommerce", html=(r"squarespace-commerce", r"sqs-commerce"), implies=("Squarespace",)),
    Sig("Shopware", "ecommerce", html=(r"shopware", r"/bundles/storefront/"), cookies=(r"^sw-",)),
    Sig("Ecwid", "ecommerce", html=(r"ecwid\.com", r"ecwid-")),
    Sig("Wizzcommerce/Other cart", "ecommerce", html=(r"add-to-cart", r"addtocart", r"cart/add")),
    # ---- frameworks
    Sig(
        "Next.js",
        "framework",
        html=(r"/_next/static/", r"__NEXT_DATA__", r"next/dist"),
        headers=(("x-powered-by", r"next\.js"),),
        implies=("React",),
    ),
    Sig("Nuxt", "framework", html=(r"/_nuxt/", r"__NUXT__", r"window\.__NUXT"), implies=("Vue",)),
    Sig("Gatsby", "framework", html=(r"___gatsby", r"/page-data/", r"gatsby-"), implies=("React",)),
    Sig("Remix", "framework", html=(r"__remixContext", r"/build/_shared/chunk-"), implies=("React",)),
    Sig("SvelteKit", "framework", html=(r"__sveltekit", r"/_app/immutable/")),
    Sig("Astro", "framework", html=(r"astro-island", r"/_astro/"), generator=(r"^astro",)),
    Sig("Angular", "framework", html=(r"ng-version=", r"ng-app", r"<app-root")),
    Sig(
        "React",
        "framework",
        html=(r"data-reactroot", r"react-dom", r"__reactContainer", r"/react\.production\.min\.js"),
        scripts=(r"react(-dom)?(\.production)?(\.min)?\.js",),
    ),
    Sig(
        "Vue",
        "framework",
        html=(r"data-v-[0-9a-f]{6,}", r"__vue__", r"vue\.runtime", r"/vue(\.min)?\.js"),
        scripts=(r"/vue(\.runtime)?(\.global)?(\.prod)?(\.min)?\.js",),
    ),
    Sig("jQuery", "framework", scripts=(r"jquery[-.\d]*(\.min)?\.js",), html=(r"jquery",)),
    Sig("Bootstrap", "framework", scripts=(r"bootstrap(\.bundle)?(\.min)?\.js",), html=(r"bootstrap(\.min)?\.css",)),
    Sig("Tailwind CSS", "framework", html=(r"tailwindcss", r"class=\"[^\"]*\b(?:flex|grid) (?:items-center|justify-between)\b")),
    Sig("Laravel", "framework", cookies=(r"^laravel_session$", r"^XSRF-TOKEN$"), implies=("PHP",)),
    Sig("Django", "framework", cookies=(r"^csrftoken$", r"^django")),
    Sig("Ruby on Rails", "framework", cookies=(r"_session$",), html=(r"csrf-param", r"data-turbo")),
    Sig(
        "ASP.NET",
        "framework",
        headers=(("x-aspnet-version", r"."), ("x-powered-by", r"asp\.net")),
        html=(r"__VIEWSTATE", r"aspnetForm"),
        cookies=(r"^ASP\.NET_SessionId$",),
    ),
    Sig("PHP", "server", headers=(("x-powered-by", r"php"),), cookies=(r"^PHPSESSID$",)),
    Sig("Express", "server", headers=(("x-powered-by", r"express"),)),
    Sig("nginx", "server", headers=(("server", r"^nginx"),)),
    Sig("Apache", "server", headers=(("server", r"^apache"),)),
    Sig("LiteSpeed", "server", headers=(("server", r"litespeed"),)),
    Sig("Microsoft IIS", "server", headers=(("server", r"microsoft-iis"),)),
    Sig("Varnish", "cdn", headers=(("via", r"varnish"), ("x-varnish", r"."))),
    # ---- CDN / hosting
    Sig(
        "Cloudflare",
        "cdn",
        headers=(("server", r"^cloudflare"), ("cf-ray", r".")),
        dns=(r"\.ns\.cloudflare\.com$", r"cdn\.cloudflare\.net$"),
    ),
    Sig(
        "Akamai",
        "cdn",
        headers=(("server", r"akamai"), ("x-akamai-transformed", r".")),
        dns=(r"\.(edgekey|edgesuite|akamaiedge|akamaized)\.net$",),
    ),
    Sig("Fastly", "cdn", headers=(("x-served-by", r"cache-"), ("x-fastly-request-id", r".")), dns=(r"\.fastly(lb)?\.net$",)),
    Sig("Amazon CloudFront", "cdn", headers=(("via", r"cloudfront"), ("x-amz-cf-id", r".")), dns=(r"\.cloudfront\.net$",)),
    Sig("Vercel", "hosting", headers=(("server", r"^vercel"), ("x-vercel-id", r".")), dns=(r"vercel-dns\.com$", r"\.vercel\.app$")),
    Sig("Netlify", "hosting", headers=(("server", r"netlify"), ("x-nf-request-id", r".")), dns=(r"\.netlify\.app$", r"\.netlify\.com$")),
    Sig("GitHub Pages", "hosting", headers=(("server", r"github\.com"),), dns=(r"\.github\.io$",)),
    Sig(
        "Amazon Web Services",
        "hosting",
        headers=(("server", r"amazons3"), ("x-amz-request-id", r".")),
        dns=(r"\.amazonaws\.com$", r"awsdns-"),
    ),
    Sig(
        "Google Cloud",
        "hosting",
        headers=(("server", r"^gws$|google frontend|^gse$"), ("via", r"1\.1 google")),
        dns=(r"googledomains\.com$", r"\.googleusercontent\.com$", r"ghs\.googlehosted\.com$"),
    ),
    Sig(
        "Microsoft Azure",
        "hosting",
        dns=(r"\.azurewebsites\.net$", r"\.azureedge\.net$", r"\.azurefd\.net$", r"\.trafficmanager\.net$"),
        headers=(("x-azure-ref", r"."),),
    ),
    Sig("WP Engine", "hosting", headers=(("x-powered-by", r"wp engine"),), dns=(r"\.wpengine\.com$",)),
    Sig("Kinsta", "hosting", headers=(("x-kinsta-cache", r"."),), dns=(r"\.kinsta\.cloud$",)),
    Sig("Pantheon", "hosting", headers=(("x-pantheon-styx-hostname", r"."),), dns=(r"\.pantheonsite\.io$",)),
    Sig("Heroku", "hosting", dns=(r"\.herokuapp\.com$", r"\.herokudns\.com$")),
    Sig("DigitalOcean", "hosting", dns=(r"\.digitalocean\.com$", r"\.ondigitalocean\.app$")),
    Sig("Hostinger", "hosting", dns=(r"\.hostinger\.com$", r"dns-parking\.com$")),
    Sig("Bluehost", "hosting", dns=(r"\.bluehost\.com$",)),
    Sig("SiteGround", "hosting", dns=(r"\.siteground\.net$", r"sgvps\.net$")),
    Sig("Vagaro", "other", html=(r"vagaro\.com",)),
    # ---- analytics
    Sig(
        "Google Analytics",
        "analytics",
        scripts=(r"google-analytics\.com/(analytics|ga)\.js", r"googletagmanager\.com/gtag/js"),
        html=(r"gtag\('config',\s*'(UA|G)-", r"ga\('create'", r"_gaq\.push", r"googletagmanager\.com/gtag/js"),
    ),
    Sig(
        "Google Analytics 4",
        "analytics",
        html=(r"gtag\('config',\s*'G-[A-Z0-9]+'", r"googletagmanager\.com/gtag/js\?id=G-"),
        implies=("Google Analytics",),
    ),
    Sig(
        "Google Tag Manager",
        "analytics",
        scripts=(r"googletagmanager\.com/gtm\.js",),
        html=(r"googletagmanager\.com/gtm\.js", r"GTM-[A-Z0-9]{4,}"),
    ),
    Sig("Matomo", "analytics", html=(r"matomo\.js", r"piwik\.js", r"_paq\.push")),
    Sig("Plausible", "analytics", scripts=(r"plausible\.io/js/",), html=(r"plausible\.io",)),
    Sig("Fathom", "analytics", scripts=(r"usefathom\.com", r"cdn\.usefathom\.com")),
    Sig(
        "Hotjar",
        "analytics",
        html=(
            r"static\.hotjar\.com",
            r"hj\('",
        ),
    ),
    Sig("Microsoft Clarity", "analytics", html=(r"clarity\.ms/tag/",)),
    Sig("Mixpanel", "analytics", html=(r"cdn\.mxpnl\.com", r"mixpanel\.init")),
    Sig("Segment", "analytics", html=(r"cdn\.segment\.com/analytics\.js", r"analytics\.load\(")),
    Sig("Amplitude", "analytics", html=(r"cdn\.amplitude\.com", r"amplitude\.getInstance")),
    Sig("Heap", "analytics", html=(r"heapanalytics\.com", r"heap\.load\(")),
    Sig("Yandex Metrica", "analytics", html=(r"mc\.yandex\.ru/metrika", r"ym\(\d+")),
    Sig("Baidu Analytics", "analytics", html=(r"hm\.baidu\.com/hm\.js",)),
    Sig("Adobe Analytics", "analytics", html=(r"omtrdc\.net", r"s_code\.js", r"adobedtm\.com", r"AppMeasurement")),
    Sig("Cloudflare Web Analytics", "analytics", html=(r"static\.cloudflareinsights\.com/beacon",)),
    Sig("Umami", "analytics", html=(r"data-website-id=.*umami", r"umami\.js", r"/script\.js\" data-website-id")),
    # ---- advertising
    Sig(
        "Google Ads",
        "advertising",
        html=(r"googleads\.g\.doubleclick\.net", r"gtag\('config',\s*'AW-", r"googleadservices\.com/pagead/conversion", r"AW-\d{6,}"),
    ),
    Sig("Google AdSense", "advertising", html=(r"pagead2\.googlesyndication\.com/pagead/js/adsbygoogle", r"adsbygoogle")),
    Sig("Google Ad Manager", "advertising", html=(r"securepubads\.g\.doubleclick\.net", r"googletag\.pubads")),
    Sig("Meta Pixel", "advertising", html=(r"connect\.facebook\.net/[a-z_A-Z]+/fbevents\.js", r"fbq\('init'")),
    Sig("TikTok Pixel", "advertising", html=(r"analytics\.tiktok\.com/i18n/pixel", r"ttq\.load\(")),
    Sig("LinkedIn Insight Tag", "advertising", html=(r"snap\.licdn\.com/li\.lms-analytics", r"_linkedin_partner_id")),
    Sig("Pinterest Tag", "advertising", html=(r"s\.pinimg\.com/ct/core\.js", r"pintrk\(")),
    Sig("Snap Pixel", "advertising", html=(r"sc-static\.net/scevent\.min\.js", r"snaptr\(")),
    Sig("Twitter/X Pixel", "advertising", html=(r"static\.ads-twitter\.com/uwt\.js", r"twq\(")),
    Sig("Microsoft Advertising", "advertising", html=(r"bat\.bing\.com/bat\.js",)),
    Sig("Criteo", "advertising", html=(r"static\.criteo\.net", r"dynamic\.criteo\.com")),
    Sig("Taboola", "advertising", html=(r"cdn\.taboola\.com",)),
    Sig("Outbrain", "advertising", html=(r"widgets\.outbrain\.com",)),
    Sig("Amazon Associates", "advertising", html=(r"amazon-adsystem\.com", r"assoc-amazon")),
    Sig("Prebid", "advertising", html=(r"prebid(\.min)?\.js", r"pbjs\.que")),
    # ---- marketing / support / payments
    Sig("HubSpot", "marketing", html=(r"js\.hs-scripts\.com", r"js\.hsforms\.net", r"hs-analytics\.net")),
    Sig("Klaviyo", "marketing", html=(r"static\.klaviyo\.com", r"klaviyo\.js")),
    Sig("Mailchimp", "marketing", html=(r"chimpstatic\.com", r"list-manage\.com", r"mailchimp")),
    Sig("Intercom", "marketing", html=(r"widget\.intercom\.io", r"intercomSettings")),
    Sig("Drift", "marketing", html=(r"js\.driftt\.com",)),
    Sig("Zendesk", "marketing", html=(r"static\.zdassets\.com", r"zendesk\.com/embeddable")),
    Sig("Tidio", "marketing", html=(r"code\.tidio\.co",)),
    Sig("Crisp", "marketing", html=(r"client\.crisp\.chat",)),
    Sig("LiveChat", "marketing", html=(r"cdn\.livechatinc\.com",)),
    Sig("Tawk.to", "marketing", html=(r"embed\.tawk\.to",)),
    Sig("Calendly", "marketing", html=(r"assets\.calendly\.com",)),
    Sig("Typeform", "marketing", html=(r"embed\.typeform\.com",)),
    Sig("OneTrust", "marketing", html=(r"cdn\.cookielaw\.org", r"onetrust")),
    Sig("Cookiebot", "marketing", html=(r"consent\.cookiebot\.com",)),
    Sig("reCAPTCHA", "other", html=(r"google\.com/recaptcha", r"recaptcha/api\.js")),
    Sig("hCaptcha", "other", html=(r"hcaptcha\.com/1/api\.js",)),
    Sig("Stripe", "payments", html=(r"js\.stripe\.com",)),
    Sig("PayPal", "payments", html=(r"paypal\.com/sdk/js", r"paypalobjects\.com")),
    Sig("Shop Pay", "payments", html=(r"shop\.app/", r"shopify-pay"), implies=("Shopify",)),
    Sig("Klarna", "payments", html=(r"klarna\.com/", r"klarnaservices")),
    Sig("Afterpay", "payments", html=(r"afterpay\.com", r"afterpay\.js")),
    Sig("Square", "payments", html=(r"squareup\.com", r"web\.squarecdn\.com")),
    Sig("Font Awesome", "other", html=(r"font-awesome", r"fontawesome")),
    Sig("Google Fonts", "other", html=(r"fonts\.googleapis\.com",)),
    Sig("Google Maps", "other", html=(r"maps\.googleapis\.com/maps/api", r"maps\.google\.com/maps")),
    Sig("YouTube embed", "other", html=(r"youtube(-nocookie)?\.com/embed/",)),
    Sig("Vimeo embed", "other", html=(r"player\.vimeo\.com/video/",)),
    Sig("Elementor", "other", html=(r"elementor", r"/wp-content/plugins/elementor/"), implies=("WordPress",)),
    Sig("WPBakery", "other", html=(r"js_composer", r"wpb_"), implies=("WordPress",)),
    Sig("Yoast SEO", "other", html=(r"yoast seo", r"yoast-schema-graph"), implies=("WordPress",)),
    Sig("Rank Math", "other", html=(r"rank math", r"rank-math"), implies=("WordPress",)),
    Sig("Divi", "other", html=(r"/themes/Divi/", r"et_pb_"), implies=("WordPress",)),
    Sig("WP Rocket", "other", html=(r"wp-rocket", r"wp rocket", r"rocket-loader"), implies=("WordPress",)),
    Sig("Cloudflare Rocket Loader", "cdn", html=(r"ajax/libs/rocket-loader", r"rocket-loader\.min\.js"), implies=("Cloudflare",)),
)

_compiled: list[
    tuple[Sig, list[re.Pattern], list[re.Pattern], list[tuple[str, re.Pattern]], list[re.Pattern], list[re.Pattern], list[re.Pattern]]
] = []
for _sig in SIGNATURES:
    _compiled.append(
        (
            _sig,
            [re.compile(p, re.I) for p in _sig.html],
            [re.compile(p, re.I) for p in _sig.scripts],
            [(h, re.compile(p, re.I)) for h, p in _sig.headers],
            [re.compile(p, re.I) for p in _sig.cookies],
            [re.compile(p, re.I) for p in _sig.generator],
            [re.compile(p, re.I) for p in _sig.dns],
        )
    )

_GA_ID_RE = re.compile(r"\b(G-[A-Z0-9]{6,12}|UA-\d{4,10}-\d{1,3})\b")
_GTM_ID_RE = re.compile(r"\bGTM-[A-Z0-9]{4,10}\b")
_AW_ID_RE = re.compile(r"\bAW-\d{6,12}\b")
_FB_PIXEL_RE = re.compile(r"fbq\(\s*['\"]init['\"]\s*,\s*['\"](\d{8,20})['\"]")


@dataclass
class TechResult:
    technologies: dict[str, str] = field(default_factory=dict)  # name -> category
    ids: dict[str, list[str]] = field(default_factory=dict)  # ga/gtm/aw/fb_pixel ids (hashed? no: public)

    @property
    def names(self) -> list[str]:
        return sorted(self.technologies)

    def by_category(self, category: str) -> list[str]:
        return sorted(n for n, c in self.technologies.items() if c == category)

    def first(self, category: str, prefer: tuple[str, ...] = ()) -> str | None:
        found = self.by_category(category)
        for p in prefer:
            if p in found:
                return p
        return found[0] if found else None

    def to_dict(self) -> dict:
        return {
            "technologies": [{"name": n, "category": c} for n, c in sorted(self.technologies.items())],
            "count": len(self.technologies),
            "cms": self.first("cms"),
            "ecommerce_platform": self.first("ecommerce", prefer=("Shopify", "WooCommerce", "Magento", "BigCommerce")),
            "frameworks": self.by_category("framework"),
            "cdn": self.by_category("cdn"),
            "hosting": self.by_category("hosting"),
            "analytics": self.by_category("analytics"),
            "advertising": self.by_category("advertising"),
            "marketing": self.by_category("marketing"),
            "payments": self.by_category("payments"),
            "ids": {k: v[:5] for k, v in self.ids.items()},
        }


def detect(
    *,
    html_samples: list[str],
    script_urls: list[str],
    headers: dict[str, str],
    set_cookies: list[str],
    generator: str | None,
    dns_names: list[str],
) -> TechResult:
    result = TechResult()
    html_blob = "\n".join(h[:300_000] for h in html_samples)
    scripts_blob = "\n".join(script_urls)
    cookie_names = [c.split("=", 1)[0].strip() for c in set_cookies if c]
    dns_blob = "\n".join(n.lower() for n in dns_names)
    lower_headers = {k.lower(): v for k, v in headers.items()}
    for sig, html_re, script_re, header_re, cookie_re, gen_re, dns_re in _compiled:
        hit = False
        if gen_re and generator:
            hit = any(p.search(generator) for p in gen_re)
        if not hit and header_re:
            for hname, pat in header_re:
                for k, v in lower_headers.items():
                    if (k == hname or (hname.endswith("-") and k.startswith(hname))) and pat.search(v):
                        hit = True
                        break
                if hit:
                    break
        if not hit and cookie_re:
            hit = any(p.search(name) for p in cookie_re for name in cookie_names)
        if not hit and script_re:
            hit = any(p.search(scripts_blob) for p in script_re)
        if not hit and html_re:
            hit = any(p.search(html_blob) for p in html_re)
        if not hit and dns_re and dns_blob:
            hit = any(p.search(line) for p in dns_re for line in dns_blob.split("\n"))
        if hit:
            result.technologies[sig.name] = sig.category
    # Resolve implications (Next.js -> React, WooCommerce -> WordPress ...).
    changed = True
    while changed:
        changed = False
        for sig in SIGNATURES:
            if sig.name in result.technologies:
                for imp in sig.implies:
                    cat = next((s.category for s in SIGNATURES if s.name == imp), "other")
                    if imp not in result.technologies:
                        result.technologies[imp] = cat
                        changed = True
    if "Wizzcommerce/Other cart" in result.technologies:
        # Generic cart markers only count when no real platform was identified.
        if result.by_category("ecommerce") != ["Wizzcommerce/Other cart"]:
            result.technologies.pop("Wizzcommerce/Other cart")
        else:
            result.technologies["Generic shopping cart"] = result.technologies.pop("Wizzcommerce/Other cart")
    ids: dict[str, list[str]] = {}
    for key, pat in (("ga", _GA_ID_RE), ("gtm", _GTM_ID_RE), ("google_ads", _AW_ID_RE)):
        found = sorted(set(pat.findall(html_blob)))
        if found:
            ids[key] = found
    fb = sorted(set(_FB_PIXEL_RE.findall(html_blob)))
    if fb:
        ids["meta_pixel"] = fb
    result.ids = ids
    return result
