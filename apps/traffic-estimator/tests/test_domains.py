import pytest

from traffic_estimator.domains import InvalidDomain, normalize_domain, registrable_domain, reverse_domain, unreverse_domain


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("example.com", "example.com"),
        ("EXAMPLE.COM", "example.com"),
        ("https://www.example.com/path?x=1#frag", "example.com"),
        ("http://example.com/", "example.com"),
        ("example.com/", "example.com"),
        ("www.example.com", "example.com"),
        ("example.com.", "example.com"),
        ("  shop.example.co.uk  ", "example.co.uk"),
        ("user:pass@example.org:8080/x", "example.org"),
        ("https://sub.deep.example.net:443", "example.net"),
        ("münchen.de", "xn--mnchen-3ya.de"),
        ("blog.github.io", "blog.github.io"),  # github.io is a public suffix: the blog is the registrable part
    ],
)
def test_normalize(raw, expected):
    assert normalize_domain(raw).name == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "localhost",
        "example",
        "192.168.1.1",
        "[::1]",
        "exa mple.com",
        "-bad.com",
        "bad-.com",
        "a" * 64 + ".com",
        "com",
        "co.uk",
        "https://",
        "http:///x",
    ],
)
def test_invalid(raw):
    with pytest.raises(InvalidDomain):
        normalize_domain(raw)


def test_host_kept():
    nd = normalize_domain("https://Shop.Example.com/x")
    assert nd.host == "shop.example.com"
    assert nd.name == "example.com"


def test_registrable_and_reverse():
    assert registrable_domain("a.b.example.com") == "example.com"
    assert registrable_domain("example") is None
    assert reverse_domain("www.example.com") == "com.example.www"
    assert unreverse_domain("com.example") == "example.com"
