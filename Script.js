// Mobile menu toggle
const menuBtn = document.getElementById('menu');
const nav = document.getElementById('nav');
menuBtn?.addEventListener('click', () => nav.classList.toggle('open'));

// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();
