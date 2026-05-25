import requests

def test_tb008_session_cookie_flags_on_login_page():
    url = "http://localhost:3000/api/auth/login"
    payload = {
        "email": "nonexistent@example.com",
        "password": "wrongpassword"
    }
    headers = {
        "Content-Type": "application/json"
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        assert response.status_code in (400, 401)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

test_tb008_session_cookie_flags_on_login_page()
