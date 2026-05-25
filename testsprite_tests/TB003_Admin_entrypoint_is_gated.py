import requests

def test_admin_entrypoint_is_gated():
    url = "http://localhost:3000/admin"
    timeout = 30
    try:
        response = requests.get(url, timeout=timeout)
    except requests.RequestException as e:
        assert False, f"Request to {url} failed with exception: {e}"

    # The admin root requires authentication, should NOT expose admin dashboard directly
    # Possible responses: redirect to /admin/login, 401 Unauthorized, or 403 Forbidden
    # Confirm that response status code is not 200 OK (dashboard)
    assert response.status_code != 200, (
        f"Unauthenticated access to {url} returned status 200 instead of redirect or unauthorized."
    )

    # Check for common patterns: redirect location or error message in body
    if response.status_code in (301, 302, 303, 307, 308):
        location = response.headers.get("Location", "")
        assert location.startswith("/admin/login"), (
            f"Redirect location expected to start with '/admin/login', got '{location}'"
        )
    else:
        # For non-redirect responses (e.g., 401 or 403), check response content for unauthorized indicators
        content_lower = response.text.lower()
        unauthorized_keywords = ["unauthorized", "login", "forbidden", "access denied"]
        assert any(keyword in content_lower for keyword in unauthorized_keywords), (
            f"Response to unauthenticated /admin did not contain expected unauthorized message."
        )

test_admin_entrypoint_is_gated()