"""URL path heuristics shared by sitemap analysis and the crawler."""

from __future__ import annotations

import re

_MEDIA_RE = re.compile(r"\.(jpe?g|png|gif|webp|svg|avif|mp4|mp3|pdf|zip|css|js|ico|woff2?|xml)$", re.I)
_PRODUCT_RE = re.compile(r"(^|/)(products?|produkte?|produits?|prodotti|productos|shop|store|item|items|p|sku|dp)(/|$)", re.I)
_PRODUCT_HINT_RE = re.compile(r"/(dp|gp/product|p)/[A-Za-z0-9]+|-p-\d+|/pd/|/product-|/sku-", re.I)
_ARTICLE_RE = re.compile(
    r"(^|/)(blog|blogs|news|article|articles|post|posts|story|stories|press|insights|journal|magazine|"
    r"artikel|noticias|actualites|nachrichten|guides?|resources?|knowledge|learn|wiki)(/|$)",
    re.I,
)
_DATE_PATH_RE = re.compile(r"/20\d{2}/\d{1,2}(/\d{1,2})?/")
_CATEGORY_RE = re.compile(
    r"(^|/)(category|categories|collections?|catalog|kategorie|categoria|categorie|tag|tags|topics?|brands?|c)(/|$)",
    re.I,
)
_LANG_PREFIX_RE = re.compile(r"^/([a-z]{2})(-[a-z]{2})?(/|$)", re.I)


def classify_path(path: str) -> str:
    """product | article | category | media | home | page"""
    if not path or path == "/":
        return "home"
    if _MEDIA_RE.search(path):
        return "media"
    if _PRODUCT_RE.search(path) or _PRODUCT_HINT_RE.search(path):
        return "product"
    if _ARTICLE_RE.search(path) or _DATE_PATH_RE.search(path):
        return "article"
    if _CATEGORY_RE.search(path):
        return "category"
    return "page"


# ISO 639-1 codes: a two-letter first path segment only counts as a language when it is one.
ISO_639_1 = frozenset(
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es "
    "et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj "
    "kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv "
    "ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti "
    "tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split()
)
# Common two-letter path segments that are ISO codes but almost never language prefixes.
_NOT_LANG = frozenset({"id", "my", "to", "no", "so", "or", "as", "is", "it", "be", "an", "am", "pa", "co", "ie", "ta"})


def language_prefix(path: str) -> str | None:
    m = _LANG_PREFIX_RE.match(path or "")
    if not m:
        return None
    code = m.group(1).lower()
    if code not in ISO_639_1 or (code in _NOT_LANG and not m.group(2)):
        return None
    return code + (m.group(2).lower() if m.group(2) else "")
