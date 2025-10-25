// Password Configuration
const correctPassword = "love"; // Change this to your desired password

// Screen Elements
const passwordScreen = document.getElementById('passwordScreen');
const loveScreen = document.getElementById('loveScreen');
const wheelScreen = document.getElementById('wheelScreen');

// Password Screen Elements
const passwordInput = document.getElementById('passwordInput');
const submitBtn = document.getElementById('submitBtn');
const errorMsg = document.getElementById('errorMsg');

// Love Screen Elements
const continueBtn = document.getElementById('continueBtn');

// Wheel Elements
const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');
const spinBtn = document.getElementById('spinBtn');
const resultModal = document.getElementById('resultModal');
const resultText = document.getElementById('resultText');
const spinAgainBtn = document.getElementById('spinAgainBtn');

// Gift options for the wheel
const gifts = [
    "💝 A romantic dinner date",
    "🎬 Movie night of your choice",
    "🍰 Your favorite dessert",
    "💆 Relaxing massage",
    "🎮 Game night together",
    "🌹 A bouquet of flowers",
    "☕ Coffee date at your fav spot",
    "🎨 Art class together"
];

const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A',
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'
];

let currentRotation = 0;
let isSpinning = false;

// Password Screen Logic
function checkPassword() {
    const enteredPassword = passwordInput.value.trim();
    
    if (enteredPassword === correctPassword) {
        errorMsg.textContent = '';
        passwordScreen.classList.remove('active');
        loveScreen.classList.add('active');
        passwordInput.value = '';
    } else {
        errorMsg.textContent = '❌ Oops! Try again...';
        passwordInput.value = '';
        passwordInput.style.animation = 'shake 0.5s';
        setTimeout(() => {
            passwordInput.style.animation = '';
        }, 500);
    }
}

submitBtn.addEventListener('click', checkPassword);
passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        checkPassword();
    }
});

// Add shake animation
const style = document.createElement('style');
style.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-10px); }
        20%, 40%, 60%, 80% { transform: translateX(10px); }
    }
`;
document.head.appendChild(style);

// Love Screen Logic
continueBtn.addEventListener('click', () => {
    loveScreen.classList.remove('active');
    wheelScreen.classList.add('active');
    drawWheel();
});

// Wheel Drawing Function
function drawWheel() {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 180;
    const sliceAngle = (2 * Math.PI) / gifts.length;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(currentRotation);

    // Draw slices
    for (let i = 0; i < gifts.length; i++) {
        const startAngle = i * sliceAngle;
        const endAngle = startAngle + sliceAngle;

        // Draw slice
        ctx.beginPath();
        ctx.arc(0, 0, radius, startAngle, endAngle);
        ctx.lineTo(0, 0);
        ctx.fillStyle = colors[i];
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Draw text
        ctx.save();
        ctx.rotate(startAngle + sliceAngle / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 3;
        
        // Split text into lines for better readability
        const words = gifts[i].split(' ');
        const line1 = words[0];
        const line2 = words.slice(1).join(' ');
        
        ctx.fillText(line1, radius * 0.65, -5);
        if (line2) {
            ctx.font = 'bold 11px Arial';
            ctx.fillText(line2, radius * 0.65, 10);
        }
        ctx.restore();
    }

    // Draw center circle border
    ctx.beginPath();
    ctx.arc(0, 0, 50, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#764ba2';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.restore();
}

// Spin Wheel Function
function spinWheel() {
    if (isSpinning) return;
    
    isSpinning = true;
    spinBtn.disabled = true;
    spinBtn.textContent = 'SPINNING...';

    const spinDuration = 4000; // 4 seconds
    const minSpins = 5;
    const maxSpins = 8;
    const spins = Math.random() * (maxSpins - minSpins) + minSpins;
    const totalRotation = spins * 2 * Math.PI;
    
    // Random final position
    const randomStop = Math.random() * 2 * Math.PI;
    const finalRotation = totalRotation + randomStop;

    const startTime = Date.now();
    const startRotation = currentRotation;

    function animate() {
        const now = Date.now();
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / spinDuration, 1);

        // Easing function for smooth deceleration
        const easeOut = 1 - Math.pow(1 - progress, 3);
        
        currentRotation = startRotation + finalRotation * easeOut;
        drawWheel();

        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            currentRotation = currentRotation % (2 * Math.PI);
            drawWheel();
            showResult(randomStop);
            isSpinning = false;
            spinBtn.disabled = false;
            spinBtn.textContent = 'SPIN!';
        }
    }

    animate();
}

// Show Result Function
function showResult(finalAngle) {
    const sliceAngle = (2 * Math.PI) / gifts.length;
    // Adjust for pointer at top (subtract 90 degrees / π/2)
    const adjustedAngle = (2 * Math.PI - finalAngle + Math.PI / 2) % (2 * Math.PI);
    const winningIndex = Math.floor(adjustedAngle / sliceAngle);
    const winningGift = gifts[winningIndex];

    resultText.textContent = winningGift;
    resultModal.classList.add('active');
}

// Event Listeners
spinBtn.addEventListener('click', spinWheel);
spinAgainBtn.addEventListener('click', () => {
    resultModal.classList.remove('active');
});

// Close modal when clicking outside
resultModal.addEventListener('click', (e) => {
    if (e.target === resultModal) {
        resultModal.classList.remove('active');
    }
});

// Initial wheel draw
drawWheel();

