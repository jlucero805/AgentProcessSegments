import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Dark by default; the brain serves the dark palette first paint too.
document.documentElement.classList.add('dark');

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
