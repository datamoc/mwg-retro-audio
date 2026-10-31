# Micro-spécification : Synthèse Sonore Pong (1972)

## 1. Objectif
Implémenter la génération audio du jeu **Pong** en respectant les fréquences, durées et formes d'onde d'origine (circuits logiques TTL de 1972).

---

## 2. Spécifications des Effets Sonores (SFX)

| Événement | Fréquence (Hz) | Durée (ms) | Forme d'onde | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Wall Bounce** | $226\text{ Hz}$ ($\approx A_3$) | $16\text{ ms}$ | Carrée (`square`) | Rebond sur le mur haut/bas |
| **Paddle Hit** | $459\text{ Hz}$ ($\approx A_4$) | $96\text{ ms}$ | Carrée (`square`) | Rebond sur une raquette |
| **Point Scored** | $490\text{ Hz}$ ($\approx B_4$) | $257\text{ ms}$ | Carrée (`square`) | Balle manquée / Point marqué |

---

## 3. Architecture d'Implémentation (Web Audio API)

### 3.1 Chaîne d'Audio
```
[ OscillatorNode (Square) ] ──> [ GainNode (Envelope) ] ──> [ AudioContext.destination ]
```

### 3.2 Modèle d'Enveloppe
* **Attaque :** $0\text{ ms}$ (Coupure nette / instantanée).
* **Décroissance/Maintien :** Amplitude constante ($1.0$) pendant la durée exacte du son.
* **Relâchement :** $0\text{ ms}$ (Coupure immédiate).

---

## 4. Exemple d'Implémentation (JavaScript)

```javascript
class PongAudio {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
  }

  playSound(frequency, durationMs) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    // Forme d'onde carrée pour simuler les circuits logiques TTL
    osc.type = 'square';
    osc.frequency.setValueAtTime(frequency, this.ctx.currentTime);

    // Enveloppe rectangulaire stricte
    gain.gain.setValueAtTime(1, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, this.ctx.currentTime + (durationMs / 1000));

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start();
    osc.stop(this.ctx.currentTime + (durationMs / 1000));
  }

  // API Publique
  playWallBounce() { this.playSound(226, 16); }
  playPaddleHit()  { this.playSound(459, 96); }
  playScore()      { this.playSound(490, 257); }
}
```

---

## 5. Critères d'Acceptation
- [ ] L'onde utilisée est **strictement carrée** (pas de sinusoïde ni de triangle).
- [ ] Les fréquences respectent la tolérance de $\pm 2\text{ Hz}$.
- [ ] Aucun effet de *fade-in* ou *fade-out* (enveloppe rectangulaire nette).
- [ ] Les déclenchements se font sans latence perceptible lors des collisions de balle.