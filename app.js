// ===== NAVBAR SCROLL =====
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 50);
});

// ===== MOBILE NAV TOGGLE =====
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
});
// Close menu on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => navLinks.classList.remove('open'));
});

// ===== SCROLL REVEAL =====
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

document.querySelectorAll('.service-card, .price-card, .area-card, .area-feature, .contact-card, .section-header').forEach(el => {
  el.classList.add('reveal');
  revealObserver.observe(el);
});

// ===== STAGGER ANIMATIONS =====
document.querySelectorAll('.services-grid .service-card').forEach((card, i) => {
  card.style.transitionDelay = `${i * 0.08}s`;
});
document.querySelectorAll('.area-features .area-feature').forEach((feat, i) => {
  feat.style.transitionDelay = `${i * 0.08}s`;
});

// ===== SMOOTH ACTIVE NAV LINKS =====
const sections = document.querySelectorAll('section[id]');
const links = document.querySelectorAll('.nav-link');

window.addEventListener('scroll', () => {
  let current = '';
  sections.forEach(sec => {
    if (window.scrollY >= sec.offsetTop - 100) current = sec.id;
  });
  links.forEach(link => {
    link.style.color = link.getAttribute('href') === '#' + current
      ? 'var(--white)' : '';
  });
});
