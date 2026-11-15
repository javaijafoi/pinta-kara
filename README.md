# Pinta-Kara

Desenhe no ar usando só as mãos e a webcam.

**No ar:** https://pinta-kara.vercel.app

A câmera acompanha as duas mãos em tempo real. Junte o polegar e o indicador (pinça) para desenhar, solte para parar. Os botões de cor e de ação também podem ser apertados com a mão, sem tocar no mouse.

Toda a visão computacional roda no navegador com o MediaPipe Hand Landmarker: nenhuma imagem da câmera sai do seu computador. O navegador só guarda se você já viu o tutorial de abertura.

## Rodar localmente

```bash
npm install
npm run dev
```

## Tecnologias

JavaScript, Canvas, MediaPipe Tasks Vision, Vite.
