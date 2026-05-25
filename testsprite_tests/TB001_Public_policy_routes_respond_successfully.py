import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_public_policy_routes_respond_successfully():
    """
    Verify core public backend-rendered routes are reachable.
    Routes tested based on PRD routes with no authentication required.
    """
    public_routes = [
        "/", "/login", "/register", "/forgot-password", "/reset-password",
        "/about", "/contact", "/privacy", "/terms", "/cookie-policy",
        "/faq", "/help", "/docs", "/how-it-works", "/why-ovlink",
        "/abuse-safety", "/updates"
    ]

    for route in public_routes:
        url = BASE_URL + route
        try:
            response = requests.get(url, timeout=TIMEOUT)
            assert response.status_code == 200, f"Route {route} returned status code {response.status_code}"
            # Optionally verify that content-type is text/html (common for backend-rendered pages)
            content_type = response.headers.get("Content-Type", "")
            assert "text/html" in content_type.lower(), f"Route {route} content type is not HTML: {content_type}"
        except requests.RequestException as e:
            assert False, f"Request to {route} failed with exception: {e}"

test_public_policy_routes_respond_successfully()