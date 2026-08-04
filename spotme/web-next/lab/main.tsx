/**
 * Camera-lab entry — LAB-ONLY. Vite includes this HTML/entry pair in the
 * build ONLY when CAMERA_LAB_ENABLED=true (see vite.config.ts). It is never
 * an input to the production build, never routed, never linked from App.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CameraLab } from './CameraLab';
import './camera-lab.css';

const root = document.getElementById('lab-root');
if (root) createRoot(root).render(<StrictMode><CameraLab /></StrictMode>);
