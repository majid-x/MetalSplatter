import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Keep OS file drops inside the app (don't navigate the BrowserWindow).
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
