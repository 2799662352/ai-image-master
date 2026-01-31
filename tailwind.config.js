/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx,html}',
    './js/**/*.js',
    './css/**/*.css'
  ],
  theme: {
    extend: {
      colors: {
        // Cyberpunk 主题色
        'cyberpunk': {
          'yellow': '#FCE300',
          'black': '#09090B',
          'dark': '#1a1a2e',
          'accent': '#FFE500'
        }
      },
      fontFamily: {
        'orbitron': ['Orbitron', 'sans-serif'],
        'exo': ['Exo 2', 'sans-serif'],
        'noto-sc': ['Noto Sans SC', 'sans-serif']
      },
      animation: {
        'spin': 'spin 1s linear infinite',
        'pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
      }
    }
  },
  plugins: []
}
