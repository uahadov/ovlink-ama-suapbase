import requests

def test_security_headers_present_on_backend_responses():
    url = "http://localhost:3000/"
    timeout = 30
    expected_security_headers = {
        "Content-Security-Policy",
        "X-DNS-Prefetch-Control",
        "X-Frame-Options",
        "X-Download-Options",
        "X-Content-Type-Options",
        "X-Permitted-Cross-Domain-Policies",
        "Referrer-Policy",
        "Expect-CT",
        "Feature-Policy"  # or Permissions-Policy depending on implementation/version
    }

    try:
        response = requests.get(url, timeout=timeout)
    except requests.RequestException as e:
        assert False, f"Request to {url} failed with exception: {e}"

    # Assert response status code is 200 OK
    assert response.status_code == 200, f"Expected 200 OK but got {response.status_code}"

    # Check that key security headers are present and have non-empty values
    for header in expected_security_headers:
        assert header in response.headers, f"Missing security header: {header}"
        value = response.headers.get(header, "").strip()
        assert value, f"Security header {header} is empty"

test_security_headers_present_on_backend_responses()