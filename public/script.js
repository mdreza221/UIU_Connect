let isLogin = true;
const BASE_URL = 'http://localhost:3000'; // Consider if this is truly needed with relative paths

const formTitle = document.getElementById('form-title'); // These elements are not in index.html as separate IDs now
const submitBtn = document.getElementById('submit-btn'); // Consider removing if index.html is the source of truth
const toggleForm = document.getElementById('toggle-form'); // Consider removing if index.html is the source of truth
const authForm = document.getElementById('auth-form'); // Consider removing if index.html is the source of truth

const nameField = document.getElementById('name'); // These are specific to signup, ensure correct IDs if used
const emailField = document.getElementById('email');

// The following event listener and form submission logic duplicate what is in index.html's embedded script.
// If index.html's embedded script is active, this file's logic will not be used unless explicitly linked.
// It is recommended to choose one approach (embedded script or external script) and remove the duplicate.

toggleForm.addEventListener('click', () => {
  isLogin = !isLogin;
  formTitle.textContent = isLogin ? 'Login' : 'Sign Up';
  submitBtn.textContent = isLogin ? 'Login' : 'Sign Up';
  toggleForm.textContent = isLogin
    ? "Don't have an account? Sign Up"
    : "Already have an account? Login";

  document.querySelectorAll('.signup-only').forEach(input => { // '.signup-only' class not found in provided index.html
    input.style.display = isLogin ? 'none' : 'block';
    input.required = !isLogin;
  });
});

authForm.addEventListener('submit', function (e) {
  e.preventDefault();

  const username = document.getElementById('username').value.trim(); // ID is loginUsername/signupUsername in index.html
  const password = document.getElementById('password').value.trim(); // ID is loginPassword/signupPassword in index.html

  if (!username || !password) {
    return alert('Username and password are required.');
  }

  const data = { username, password };

  if (!isLogin) {
    const name = nameField.value.trim();
    const email = emailField.value.trim();

    if (!name || !email) {
      return alert('All fields are required.');
    }

    data.name = name;
    data.email = email;
  }

  const endpoint = isLogin ? '/login' : '/signup';

  fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
      if (data.success && isLogin) { // 'data.success' property is not sent by server.js, only 'message' or 'error'
        window.location.href = '/forum.html'; // server.js redirects to /profile
      }
    })
    .catch(() => alert('Network error'));
});