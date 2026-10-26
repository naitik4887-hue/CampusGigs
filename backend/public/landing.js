// If the visitor is already logged in, swap the sign-up buttons for a direct link into the app.
(async function () {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const { user } = await res.json();
    const first = String(user.name).split(' ')[0];

    document.getElementById('navActions').innerHTML =
      '<a class="btn btn-primary" href="/app.html">Open CampusGigs</a>';

    const hero = document.getElementById('heroCta');
    hero.replaceChildren();
    const open = document.createElement('a');
    open.className = 'btn btn-primary btn-lg';
    open.href = '/app.html';
    open.textContent = `Welcome back, ${first}. Open CampusGigs`;
    hero.append(open);

    const band = document.getElementById('ctaBand');
    band.querySelector('h2').textContent = `Welcome back, ${first}`;
    band.querySelector('p').textContent = 'Pick up where you left off.';
    const link = band.querySelector('a');
    link.href = '/app.html';
    link.textContent = 'Open CampusGigs';
  } catch (_) {
    /* not logged in, keep the default buttons */
  }
})();
