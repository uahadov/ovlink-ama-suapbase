import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_authenticated_endpoint_rejects_anonymous():
    url = BASE_URL + "/dashboard"  # session protected endpoint per PRD
    
    try:
        response = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to {url} failed with exception: {e}"
    
    # Expect unauthorized access, could be 401 Unauthorized or redirect to login (302)
    # Check status code for unauthorized or redirect to login
    unauthorized_statuses = [401, 403]
    redirect_status_codes = [302, 303, 307, 308]
    
    if response.status_code in unauthorized_statuses:
        # Possibly a JSON or text response with an error
        assert response.status_code in unauthorized_statuses, f"Expected unauthorized status but got {response.status_code}"
    elif response.status_code in redirect_status_codes:
        # Check Location header points to /login or /admin/login (common pattern for auth redirect)
        location = response.headers.get("Location", "")
        assert "/login" in location, f"Redirect location does not appear to be login page: {location}"
    else:
        # If success code returned (200), unauthorized access is not properly blocked
        assert False, f"Unauthenticated access to protected endpoint returned status {response.status_code}, expected unauthorized or redirect."

test_authenticated_endpoint_rejects_anonymous()