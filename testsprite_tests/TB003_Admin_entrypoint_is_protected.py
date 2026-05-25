import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_admin_entrypoint_is_protected():
    url = f"{BASE_URL}/admin"
    try:
        response = requests.get(url, allow_redirects=False, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise AssertionError(f"Request to {url} failed: {e}")

    # The admin entrypoint requires authentication, so unauthenticated access should not expose admin dashboard.
    # It could either redirect to /admin/login or return 401/403 unauthorized response.
    # Assert that the response does NOT return 200 OK because that would expose admin dashboard without auth.
    assert response.status_code != 200, \
        f"Unauthenticated access to admin entrypoint returned status code 200, exposing admin dashboard."

    # Common expected behavior:
    # - Redirect (usually 302 or 303) to /admin/login
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("Location", "")
        assert location.endswith("/admin/login"), \
            f"Unauthenticated admin access redirected to unexpected location: {location}"
    else:
        # Otherwise expect a 401 Unauthorized or 403 Forbidden or similar
        assert response.status_code in (401, 403), \
            f"Unauthenticated admin access returned unexpected status code {response.status_code}"

test_admin_entrypoint_is_protected()