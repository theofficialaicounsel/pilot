const DEFAULT_PROXY_URL = "https://ai-proxy.ai-n.workers.dev/api/generate";
const STORAGE_KEY = "ai_ndraft_data_v2";

const SYSTEM_PROMPT = `You are a helpful, casual AI assistant. You can control styling and app behavior.

1. VISUAL STYLING (Start of response):
   - Page Theme: !theme:Name,BgHex,CardBgHex,TextHex,BorderHex,PrimaryHex!
   - Card Style: !bg:#hex! !text:#hex! !border:#hex! !pad:px! !radius:px! !bold! !italic!

2. APP ACTIONS (Hidden commands, put at end):
   - !action:merge! (Merges current selection)
   - !action:clear! (Clears the entire board)
   - !action:view:grid! or !action:view:list! or !action:view:full! (Changes view)

Example 1 (Style + Action):
!theme:Gold,#1a1a1a,#2a2a2a,#ffd700,#ffd700,#b8860b!
Hello World
!action:view:grid!

User requests are natural language. Be efficient.`;

class App {
    constructor() {
        this.cards = [];
        this.history = []; 
        this.sessionId = "sess_" + Date.now();
        this.theme = {
            name: 'ai-Ndraft',
            primary: '#c41e3a',
            bg: '#121212',
            cardBg: '#1e1e1e',
            text: '#f5f5f5',
            border: '#333',
            locked: false
        };
        this.settings = {
            view: 'list',
            autoTTS: false,
            asrEnabled: false,
            proxyUrl: ''
        };

        this.streamingId = null;
        this.selectedIds = new Set();
        this.contextMenuTargetId = null;
        this.fullscreenId = null;
        this.fsFlipped = false;
        this.editingId = null; 
        this.editingField = null;
        this.stylingId = null; 
        this.promptContext = null; 

        this.recognizer = null;
        this.isListening = false;

        this.decoder = new TextDecoder();
        this.abortController = null;
    }

    async init() {
        this.loadState();
        this.applyTheme();
        this.applyView();
        this.bindEvents();
        this.initASR();
        this.renderAll();
        this.updateToggles();
        
        const proxyInput = document.getElementById('proxyUrlInput');
        if (proxyInput && this.settings.proxyUrl) proxyInput.value = this.settings.proxyUrl;

        document.getElementById('stylePadding').addEventListener('input', (e) => document.getElementById('valPad').textContent = e.target.value + 'px');
        document.getElementById('styleRadius').addEventListener('input', (e) => document.getElementById('valRad').textContent = e.target.value + 'px');
        document.getElementById('styleWidth').addEventListener('input', (e) => document.getElementById('valWid').textContent = e.target.value + 'px');
    }

    getProxyUrl() {
        const inputVal = document.getElementById('proxyUrlInput')?.value.trim();
        if (inputVal) {
            this.settings.proxyUrl = inputVal;
            this.saveState();
            return inputVal;
        }
        return this.settings.proxyUrl || DEFAULT_PROXY_URL;
    }

    bindEvents() {
        const sendBtn = document.getElementById('sendBtn');
        sendBtn.addEventListener('click', () => this.handleSendClick());
        
        const input = document.getElementById('userInput');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendClick();
            }
        });

        document.getElementById('menuFab').addEventListener('click', () => this.openModal('settingsModal'));
        document.getElementById('viewFab').addEventListener('click', () => this.cycleView());
        document.getElementById('undoFabTop').addEventListener('click', () => this.undo());

        document.getElementById('cancelSelect').addEventListener('click', () => this.clearSelection());
        document.getElementById('mergeSelected').addEventListener('click', () => this.promptAction('merge'));
        document.getElementById('deleteSelected').addEventListener('click', () => this.bulkDelete());
        document.getElementById('splitSelected').addEventListener('click', () => this.promptAction('split'));

        document.getElementById('cardMenu').addEventListener('click', (e) => {
            const btn = e.target.closest('.menu-item');
            if (btn && this.contextMenuTargetId) {
                const action = btn.dataset.action;
                if (action === 'undo') {
                    this.undo();
                } else {
                    this.handleCardAction(action, this.contextMenuTargetId);
                }
                this.closeCardMenu();
            }
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    const id = overlay.id;
                    this.closeModal(id);
                }
            });
        });

        document.getElementById('promptConfirmBtn').addEventListener('click', () => this.executePromptAction());

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#cardMenu') && !e.target.closest('.card-actions') && !e.target.closest('.flip-card')) {
                this.closeCardMenu();
            }
        });
    }

    saveState() {
        const data = {
            cards: this.cards,
            theme: this.theme,
            settings: this.settings,
            sessionId: this.sessionId
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }

    loadState() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            try {
                const data = JSON.parse(raw);
                this.cards = data.cards || [];
                this.theme = { ...this.theme, ...data.theme };
                this.settings = { ...this.settings, ...data.settings };
                this.sessionId = data.sessionId || this.sessionId;
            } catch (e) {
                console.error("Load failed", e);
            }
        }
    }

    pushHistory(actionType) {
        if (this.history.length > 10) this.history.shift();
        this.history.push({
            cards: JSON.parse(JSON.stringify(this.cards)),
            theme: { ...this.theme },
            timestamp: Date.now(),
            action: actionType
        });
        this.showToast(`Saved: ${actionType}`);
    }

    undo() {
        if (this.history.length === 0) {
            this.showToast("Nothing to undo");
            return;
        }
        const lastState = this.history.pop();
        this.cards = lastState.cards;
        if (!this.theme.locked) this.theme = lastState.theme;
        
        this.saveState();
        this.renderAll();
        this.applyTheme();
        this.showToast("Undid: " + lastState.action);
    }

    exportData() {
        const data = {
            cards: this.cards,
            theme: this.theme,
            settings: this.settings,
            sessionId: this.sessionId
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ai_ndraft_export_${Date.now()}.json`;
        a.click();
        this.showToast("Export downloaded");
    }

    importData(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                this.pushHistory("Pre-Import Backup");
                this.cards = data.cards || [];
                this.theme = data.theme || this.theme;
                this.settings = data.settings || this.settings;
                this.sessionId = data.sessionId || this.sessionId;
                
                this.renderAll();
                this.applyTheme();
                this.applyView();
                this.saveState();
                this.showToast("Import Successful");
                this.closeModal('settingsModal');
            } catch (err) {
                alert("Invalid JSON file");
            }
        };
        reader.readAsText(file);
        input.value = ''; 
    }

    clearAll() {
        if (confirm("Are you sure you want to delete ALL cards? This cannot be undone.")) {
            this.pushHistory("Clear All");
            this.cards = [];
            this.saveState();
            this.renderAll();
            this.closeModal('settingsModal');
            this.showToast("Grid Cleared");
        }
    }

    addCard(q, r, styles = {}) {
        const id = crypto.randomUUID();
        const card = { id, q, r, styles };
        this.cards.push(card);
        this.pushHistory("Add Card");
        this.renderCard(card, true);
        return id;
    }

    deleteCard(id) {
        this.cards = this.cards.filter(c => c.id !== id);
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (el) el.remove();
        if (this.fullscreenId === id) this.closeFullscreen();
        this.saveState();
    }

    updateCardContent(id, q, r) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;
        if (q !== null) card.q = q;
        if (r !== null) card.r = r;
        
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (el) {
            if (q !== null) el.querySelector('.card-face:first-child .content').innerHTML = this.md(q);
            if (r !== null) {
                const rEl = el.querySelector('.response-content');
                if (rEl) rEl.innerHTML = this.md(r);
            }
        }
        this.saveState();
    }

    renderAll() {
        const grid = document.getElementById('grid');
        const empty = document.getElementById('emptyState');
        grid.innerHTML = '';
        
        if (this.cards.length === 0) {
            grid.appendChild(empty);
            empty.style.display = 'flex';
        } else {
            empty.style.display = 'none';
            this.cards.forEach(c => this.renderCard(c, false));
        }
    }

    renderCard(card, isNew) {
        const grid = document.getElementById('grid');
        const empty = document.getElementById('emptyState');
        if (empty && empty.parentNode) empty.remove();

        const div = document.createElement('div');
        div.className = `flip-card ${isNew ? 'new' : ''}`;
        div.dataset.id = card.id;
        div.tabIndex = 0;
        
        if (card.styles && card.styles.locked) {
            div.classList.add('locked');
        }

        let rHtml;
        if (card.r === '...') {
            if (this.streamingId === card.id) {
                rHtml = '<div class="streaming"><span class="thinking-indicator">Thinking...</span><button class="stop-stream-btn" onclick="app.stopStream()">Stop</button></div>';
            } else {
                rHtml = '<div class="streaming"><span class="thinking-indicator">Thinking...</span></div>';
            }
        } else {
            rHtml = this.md(card.r);
        }

        div.innerHTML = `
            <div class="flip-card-inner">
                <div class="card-face">
                    <div class="card-header">
                        <span style="font-size:11px; opacity:0.5;">REQ</span>
                        <div class="card-actions">
                            <button onclick="app.openCardMenu('${card.id}', event)"><i class="fas fa-ellipsis-v"></i></button>
                            <button onclick="app.toggleSelect('${card.id}', event)"><i class="fas fa-check-circle"></i></button>
                        </div>
                    </div>
                    <div class="content">${this.md(card.q)}</div>
                </div>
                <div class="card-face card-back">
                    <div class="card-header">
                        <span style="font-size:11px; opacity:0.5;">RESPONSE</span>
                        <div class="card-actions">
                            <button onclick="app.readCard('${card.id}', event)"><i class="fas fa-volume-up"></i></button>
                            <button onclick="app.openCardMenu('${card.id}', event)"><i class="fas fa-ellipsis-v"></i></button>
                        </div>
                    </div>
                    <div class="response-content">${rHtml}</div>
                </div>
            </div>
        `;

        if (card.styles) this.applyCardStyleToEl(div, card.styles);

        this.attachCardEvents(div, card.id);
        grid.appendChild(div);
    }

    attachCardEvents(div, id) {
        div.addEventListener('click', (e) => {
            if (e.target.closest('button') || e.target.closest('.card-actions')) return;
            if (this.selectedIds.size > 0) {
                e.stopPropagation();
                this.toggleSelect(id, e);
                return;
            }
            div.classList.toggle('flipped');
        });

        let lastTap = 0;
        div.addEventListener('touchend', (e) => {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTap;
            if (tapLength < 300 && tapLength > 0) {
                if (e.target.closest('button') || e.target.closest('.card-actions')) return;
                this.openFullscreen(id);
                e.preventDefault();
            }
            lastTap = currentTime;
        });
        div.addEventListener('dblclick', (e) => {
            if (!e.target.closest('button')) this.openFullscreen(id);
        });

        let pressTimer;
        div.addEventListener('touchstart', (e) => {
            if (this.selectedIds.size > 0) return;
            pressTimer = setTimeout(() => {
                this.openCardMenu(id, e);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 400);
        });
        div.addEventListener('touchend', () => clearTimeout(pressTimer));
        div.addEventListener('touchmove', () => clearTimeout(pressTimer));

        div.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') div.classList.toggle('flipped');
            if (e.key === ' ' && e.shiftKey) {
                e.preventDefault();
                this.openCardMenu(id);
            }
        });
    }

    handleSendClick() {
        const input = document.getElementById('userInput');
        const val = input.value.trim();
        if (!val) return;

        if (this.isListening) {
            this.recognition.stop();
            return;
        }

        if (this.settings.asrEnabled && this.recognizer) {
            this.recognition.start();
            return;
        }

        this.sendRequest(val);
        input.value = '';
    }

    scrollToBottom(element, force = false) {
        if (!element) return;
        const isNearBottom = (element.scrollHeight - element.scrollTop - element.clientHeight) < 150;
        if (force || isNearBottom) {
            element.scrollTop = element.scrollHeight;
        }
    }

    async sendRequest(prompt, contextCardId = null) {
        this.streamingId = contextCardId ? contextCardId : this.addCard(prompt, '...', {});
        
        const cardEl = document.querySelector(`.flip-card[data-id="${this.streamingId}"]`);
        if(cardEl && !contextCardId) setTimeout(() => cardEl.classList.add('flipped'), 100);

        let fullPrompt = SYSTEM_PROMPT + "\n\nUser: " + prompt;
        if (contextCardId) {
            const oldCard = this.cards.find(c => c.id === contextCardId);
            if (oldCard) {
                const styleContext = (oldCard.styles && oldCard.styles.locked) ? `(Note: Original card has locked styles)` : '';
                fullPrompt = `Previous Request: "${oldCard.q}"\nPrevious Response: "${oldCard.r}" ${styleContext}\n\nUser Instruction: ${prompt}\n\nProvide a continuation or refinement.`;
            }
        }

        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const url = this.getProxyUrl();
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: this.sessionId, prompt: fullPrompt }),
                signal
            });

            if (!res.ok) throw new Error(`Proxy Error: ${res.status}`);

            const reader = res.body.getReader();
            let buffer = '';
            let accumulated = '';
            let isFirstChunk = true;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += this.decoder.decode(value, { stream: true });
                
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const jsonStr = line.replace('data: ', '').trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;
                    try {
                        const json = JSON.parse(jsonStr);
                        const chunk = json.choices?.[0]?.delta?.content;
                        if (chunk) {
                            accumulated += chunk;
                            if (isFirstChunk) {
                                this.updateStreamingContent(accumulated, true);
                                isFirstChunk = false;
                            } else {
                                this.updateStreamingContent(accumulated, false);
                            }
                        }
                    } catch {}
                }
            }

            this.finalizeResponse(accumulated);

        } catch (err) {
            if (err.name === 'AbortError') {
                const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
                if (el) el.innerHTML += '<div style="color:#ff6b6b; margin-top:10px;">[Stopped]</div>';
            } else {
                const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
                if (el) el.innerHTML = `<span style="color: #ff6b6b; font-weight: bold;">Error: ${err.message}</span>`;
            }
            this.streamingId = null;
        } finally {
            this.abortController = null;
        }
    }

    stopStream() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
            this.showToast("Streaming stopped");
        }
    }

    updateStreamingContent(text, replace = false) {
        if (!this.streamingId) return;
        const visible = text.replace(/![^!]+!/g, '');
        
        const el = document.querySelector(`.flip-card[data-id="${this.streamingId}"] .response-content`);
        if (el) {
            if (replace) {
                el.innerHTML = this.md(visible);
            } else {
                el.innerHTML = this.md(visible) + '<div class="streaming"><span class="cursor"></span></div>';
            }
            this.scrollToBottom(el, replace);
        }

        if (this.fullscreenId === this.streamingId) {
            const fsEl = document.getElementById('fsResponse');
            if (fsEl) {
                if (replace) {
                    fsEl.innerHTML = this.md(visible);
                } else {
                    fsEl.innerHTML = this.md(visible) + '<div class="streaming"><span class="cursor"></span></div>';
                }
                const fsPane = document.getElementById('fsResponsePane');
                this.scrollToBottom(fsPane, replace);
            }
        }
    }

    finalizeResponse(fullText) {
        const id = this.streamingId;
        if (!id) return;

        const { cleanText, styles, themeUpdate, actions } = this.parseCommands(fullText);
        const card = this.cards.find(c => c.id === id);
        
        if (card) {
            if (card.styles && card.styles.locked) {
                this.showToast("Card Locked - Style changes ignored");
            } else {
                if (Object.keys(styles).length > 0) {
                    card.styles = { ...card.styles, ...styles };
                }
            }
            card.r = cleanText;
        }

        const cleanHtml = this.md(cleanText);
        const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
        if (el) el.innerHTML = cleanHtml;

        if (this.fullscreenId === id) {
            document.getElementById('fsResponse').innerHTML = cleanHtml;
        }

        if (card && (!card.styles || !card.styles.locked)) {
            if (Object.keys(styles).length > 0) {
                const cardEl = document.querySelector(`.flip-card[data-id="${id}"]`);
                if (cardEl) this.applyCardStyleToEl(cardEl, styles);
            }
        }

        if (themeUpdate) {
            if (this.theme.locked) {
                this.showToast("Global Theme Locked");
            } else {
                this.theme = { ...this.theme, ...themeUpdate };
                this.applyTheme();
                this.saveState();
                this.showToast(`Theme: ${themeUpdate.name || 'Updated'}`);
            }
        }

        if (actions.length > 0) {
            actions.forEach(action => {
                if (action === 'clear') this.clearAll();
                if (action === 'merge') {
                     if (this.selectedIds.size > 1) {
                         this.merge();
                     } else {
                         this.showToast("AI requested merge, but no cards selected.");
                     }
                }
                if (action.startsWith('view:')) {
                    const view = action.split(':')[1];
                    if (['list', 'grid', 'full'].includes(view)) {
                        this.setCardView(view);
                        this.showToast(`AI switched to ${view}`);
                    }
                }
            });
        }

        if (this.settings.autoTTS) this.readCard(id);

        this.streamingId = null;
        this.pushHistory("AI Response");
    }

    parseCommands(text) {
        const cmdRegex = /!(theme|bg|text|border|pad|radius|font|bold|italic|css|action):?([^!]+)!/gi;
        let styles = {};
        let actions = [];
        let themeUpdate = null;
        let match;
        let safeText = text;

        while ((match = cmdRegex.exec(text)) !== null) {
            const type = match[1].toLowerCase();
            const val = match[2].trim();

            if (type === 'theme') {
                const [name, bg, cardBg, textC, border, primary] = val.split(',').map(s => s.trim());
                themeUpdate = { name, bg, cardBg, text: textC, border, primary };
            } else if (type === 'bg') styles.backgroundColor = val;
            else if (type === 'text') styles.color = val;
            else if (type === 'border') styles.borderColor = val;
            else if (type === 'pad') styles.padding = val.endsWith('px') ? val : val + 'px';
            else if (type === 'radius') styles.borderRadius = val.endsWith('px') ? val : val + 'px';
            else if (type === 'font') styles.fontSize = val.endsWith('px') ? val : val + 'px';
            else if (type === 'bold') styles.fontWeight = 'bold';
            else if (type === 'italic') styles.fontStyle = 'italic';
            else if (type === 'css') styles.customCSS = val;
            else if (type === 'action') actions.push(val);

            safeText = safeText.replace(match[0], '');
        }

        return { cleanText: safeText.trim(), styles, themeUpdate, actions };
    }

    applyCardStyleToEl(el, styles) {
        const face = el.querySelectorAll('.card-face');
        face.forEach(f => {
            if (styles.color) f.style.color = styles.color;
            if (styles.backgroundColor) f.style.backgroundColor = styles.backgroundColor;
            if (styles.fontSize) f.style.fontSize = styles.fontSize;
            if (styles.fontWeight) f.style.fontWeight = styles.fontWeight;
            if (styles.fontStyle) f.style.fontStyle = styles.fontStyle;
            if (styles.padding) f.style.padding = styles.padding;
        });
        
        if (styles.borderColor) el.style.borderColor = styles.borderColor;
        if (styles.borderRadius) el.style.borderRadius = styles.borderRadius;
        
        if (styles.customCSS) {
            const id = `style-${el.dataset.id}`;
            let styleTag = document.getElementById(id);
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = id;
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = `[data-id="${el.dataset.id}"] ${styles.customCSS}`;
        }
    }

    openCardMenu(id, e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        
        this.contextMenuTargetId = id;
        const menu = document.getElementById('cardMenu');
        
        let x, y;
        if (e && e.clientX) {
            x = e.clientX;
            y = e.clientY;
        } else if (e && e.touches && e.touches[0]) {
            x = e.touches[0].clientX;
            y = e.touches[0].clientY;
        } else {
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) {
                const rect = el.getBoundingClientRect();
                x = rect.left + rect.width / 2;
                y = rect.top + rect.height / 2;
            } else {
                x = window.innerWidth / 2;
                y = window.innerHeight / 2;
            }
        }

        if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
        if (y + 300 > window.innerHeight) y = window.innerHeight - 310;

        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.add('active');
    }

    closeCardMenu() {
        document.getElementById('cardMenu').classList.remove('active');
        this.contextMenuTargetId = null;
    }

    handleCardAction(action, id) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;

        switch (action) {
            case 'continue': this.promptAction('continue', id); break;
            case 'split': this.promptAction('split', id); break;
            case 'merge':
                if (!this.selectedIds.has(id)) {
                    this.selectedIds.add(id);
                    const el = document.querySelector(`.flip-card[data-id="${id}"]`);
                    if (el) el.classList.add('selected');
                }
                if (this.selectedIds.size < 2) {
                    this.showToast("Need at least 2 cards to merge");
                    this.updateSelectionUI();
                    return;
                }
                this.updateSelectionUI();
                this.promptAction('merge');
                break;
            case 'ai-edit': this.promptAction('ai-edit', id); break;
            case 'ai-theme': 
                this.editingId = id; 
                this.openModal('aiThemeModal'); 
                break;
            case 'copy': 
                navigator.clipboard.writeText(card.r || card.q || '');
                this.showToast('Copied to clipboard');
                break;
            case 'fullscreen': this.openFullscreen(id); break;
            case 'delete': 
                if(confirm("Delete this card?")) {
                    this.deleteCard(id);
                    this.showToast('Card deleted');
                }
                break;
            case 'style':
                this.stylingId = id;
                this.loadStyleValues(card.styles || {});
                this.openModal('styleModal');
                break;
            case 'manual-edit-response':
                this.editingId = id; this.editingField = 'r';
                this.openEditor(card.r);
                break;
            case 'manual-edit-question':
                this.editingId = id; this.editingField = 'q';
                this.openEditor(card.q);
                break;
        }
    }

    openModal(id) {
        document.getElementById(id).classList.add('active');
    }

    closeModal(id) {
        document.getElementById(id).classList.remove('active');
        if (id === 'promptModal') this.promptContext = null;
        if (id === 'styleModal') this.stylingId = null;
        if (id === 'textEditorModal') { this.editingId = null; this.editingField = null; }
    }

    openEditor(text) {
        document.getElementById('textEditorArea').value = text;
        document.getElementById('editorTitle').textContent = `Edit ${this.editingField === 'q' ? 'Question' : 'Response'}`;
        this.openModal('textEditorModal');
    }

    saveManualEdit() {
        const val = document.getElementById('textEditorArea').value.trim();
        if (this.editingId && this.editingField) {
            this.pushHistory("Manual Edit");
            this.updateCardContent(this.editingId, this.editingField === 'q' ? val : null, this.editingField === 'r' ? val : null);
            this.closeModal('textEditorModal');
        }
    }

    loadStyleValues(styles) {
        const lockCheck = document.getElementById('styleLocked');
        lockCheck.checked = !!styles.locked;

        document.getElementById('styleColor').value = styles.color || '#f5f5f5';
        document.getElementById('styleBg').value = styles.backgroundColor || '#1e1e1e';
        document.getElementById('styleBorder').value = styles.borderColor || '#333333';
        document.getElementById('stylePadding').value = parseInt(styles.padding || '16');
        document.getElementById('styleRadius').value = parseInt(styles.borderRadius || '16');
        document.getElementById('styleWidth').value = parseInt(styles.borderWidth || '1');
        document.getElementById('styleCustom').value = styles.customCSS || '';

        document.getElementById('valPad').textContent = (parseInt(styles.padding || '16')) + 'px';
        document.getElementById('valRad').textContent = (parseInt(styles.borderRadius || '16')) + 'px';
        document.getElementById('valWid').textContent = (parseInt(styles.borderWidth || '1')) + 'px';

        document.querySelectorAll('.toggle-btn[data-style-prop]').forEach(btn => {
            const prop = btn.dataset.styleProp;
            const val = btn.dataset.styleVal;
            const current = styles[prop];
            if ((prop === 'textDecoration' && current === 'underline') || current === val) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    saveStyles() {
        if (!this.stylingId) return;
        
        const isLocked = document.getElementById('styleLocked').checked;
        
        const styles = {
            locked: isLocked,
            color: document.getElementById('styleColor').value,
            backgroundColor: document.getElementById('styleBg').value,
            borderColor: document.getElementById('styleBorder').value,
            padding: document.getElementById('stylePadding').value + 'px',
            borderRadius: document.getElementById('styleRadius').value + 'px',
            borderWidth: document.getElementById('styleWidth').value + 'px',
            customCSS: document.getElementById('styleCustom').value
        };

        document.querySelectorAll('.toggle-btn.active').forEach(btn => {
            const prop = btn.dataset.styleProp;
            const val = btn.dataset.styleVal;
            if (prop === 'textDecoration') {
                styles.textDecoration = val;
            } else {
                styles[prop] = val;
            }
        });

        const card = this.cards.find(c => c.id === this.stylingId);
        if (card) {
            card.styles = { ...(card.styles || {}), ...styles };
            this.saveState();
            
            const el = document.querySelector(`.flip-card[data-id="${this.stylingId}"]`);
            if (el) {
                this.applyCardStyleToEl(el, styles);
                if(isLocked) el.classList.add('locked');
                else el.classList.remove('locked');
            }
            
            this.pushHistory("Style Change");
            this.closeModal('styleModal');
        }
    }

    promptAction(action, id = null) {
        if (!id && this.selectedIds.size > 0) {
            id = Array.from(this.selectedIds)[0];
        }
        if (!id && action !== 'merge') return; 

        this.promptContext = { action, id };
        const title = document.getElementById('promptTitle');
        const desc = document.getElementById('promptDesc');
        const btn = document.getElementById('promptConfirmBtn');

        if (action === 'continue') {
            title.textContent = "Continue Card";
            desc.textContent = "Instruct the AI on how to continue the response.";
            btn.textContent = "Continue";
        } else if (action === 'split') {
            title.textContent = "Split Card";
            desc.textContent = "How should the AI split this content?";
            btn.textContent = "Split";
        } else if (action === 'ai-edit') {
            title.textContent = "AI Edit";
            desc.textContent = "What changes do you want?";
            btn.textContent = "Edit";
        } else if (action === 'merge') {
            title.textContent = "Merge Cards";
            desc.textContent = "Combine selected cards. Instructions?";
            btn.textContent = `Merge (${this.selectedIds.size})`;
        }

        this.openModal('promptModal');
    }

    executePromptAction() {
        const instructions = document.getElementById('promptArea').value.trim();
        const { action, id } = this.promptContext;
        const card = this.cards.find(c => c.id === id);
        
        this.closeModal('promptModal');
        document.getElementById('promptArea').value = '';

        if (action === 'merge') {
            this.merge(instructions);
            return;
        }

        if (!card) return;
        let userPrompt = "";

        if (action === 'continue') {
            userPrompt = `CONTINUE: Original: "${card.q}". Current: "${card.r}". Instruct: ${instructions}`;
            this.sendRequest(userPrompt, id);
        } else if (action === 'split') {
            userPrompt = `SPLIT: ${instructions}. Text: ${card.r}`;
            this.sendRequest(userPrompt, null);
        } else if (action === 'ai-edit') {
            userPrompt = `EDIT: ${instructions}. Current: ${card.r}`;
            this.sendRequest(userPrompt, null);
        }
    }

    merge(instructions = "") {
        if (this.selectedIds.size < 2) {
            this.showToast("Select 2+ cards to merge");
            return;
        }

        const sel = Array.from(this.selectedIds).map(id => this.cards.find(c => c.id === id));
        const content = sel.map(c => `---\n${c.q}\n${c.r}`).join('\n');
        const prompt = instructions 
            ? `Merge these into one based on: ${instructions}\n\n${content}`
            : `Combine these into one coherent response:\n\n${content}`;

        const id = this.addCard(`Merged ${sel.length} cards`, '...', {});
        this.streamingId = id;
        this.clearSelection(); 
        this.requestMergeUpdate(id, prompt);
    }

    async requestMergeUpdate(id, prompt) {
        this.abortController = new AbortController();
        const signal = this.abortController.signal;

        try {
            const url = this.getProxyUrl();
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: this.sessionId, prompt: SYSTEM_PROMPT + "\n\nUser: " + prompt }),
                signal
            });
            if (!res.ok) throw new Error("Proxy Error");
            
            const reader = res.body.getReader();
            let buffer = '';
            let accumulated = '';
            let isFirstChunk = true;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += this.decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const jsonStr = line.replace('data: ', '').trim();
                    if (!jsonStr || jsonStr === '[DONE]') continue;
                    try {
                        const json = JSON.parse(jsonStr);
                        const chunk = json.choices?.[0]?.delta?.content;
                        if (chunk) {
                            accumulated += chunk;
                            if (isFirstChunk) {
                                this.updateStreamingContent(accumulated, true);
                                isFirstChunk = false;
                            } else {
                                this.updateStreamingContent(accumulated, false);
                            }
                        }
                    } catch {}
                }
            }
            this.finalizeResponse(accumulated);
        } catch (err) {
            if (err.name === 'AbortError') {
                const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
                if (el) el.innerHTML += '<div style="color:#ff6b6b;">[Merge Stopped]</div>';
                return;
            }
            const el = document.querySelector(`.flip-card[data-id="${id}"] .response-content`);
            if (el) el.innerHTML = `<span style="color: #ff6b6b;">Merge Failed: ${err.message}</span>`;
        } finally {
            this.abortController = null;
        }
    }

    applyAITheme() {
        const desc = document.getElementById('aiThemePrompt').value.trim();
        if (!desc) return;
        
        if (this.editingId) {
            const card = this.cards.find(c => c.id === this.editingId);
            if (card && card.styles && card.styles.locked) {
                this.showToast("Card Locked - Rejected");
                this.closeModal('aiThemeModal');
                return;
            }
        }

        if (this.theme.locked) {
            this.showToast("Global Theme Locked");
            this.closeModal('aiThemeModal');
            return;
        }

        const prompt = `Generate ONLY a style definition in this exact format:
!theme:Name,BgHex,CardBgHex,TextHex,BorderHex,PrimaryHex!
Based on this vibe: ${desc}
Do not output any other text.`;

        this.closeModal('aiThemeModal');
        this.showToast("Generating Theme...");
        
        const url = this.getProxyUrl();
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        })
        .then(res => {
            const reader = res.body.getReader();
            let fullText = "";
            const processChunk = () => {
                return reader.read().then(({done, value}) => {
                    if (done) {
                        const { themeUpdate } = this.parseCommands(fullText);
                        if (themeUpdate) {
                            this.theme = { ...this.theme, ...themeUpdate };
                            this.applyTheme();
                            this.saveState();
                            this.showToast(`Theme: ${themeUpdate.name}`);
                        } else {
                            this.showToast("Theme generation failed (parse error)");
                        }
                        return;
                    }
                    const text = this.decoder.decode(value, { stream: true });
                    fullText += text;
                    return processChunk();
                });
            };
            return processChunk();
        })
        .catch(e => {
            this.showToast("Theme generation failed");
        });
    }

    toggleSelect(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const el = document.querySelector(`.flip-card[data-id="${id}"]`);
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
            el.classList.remove('selected');
        } else {
            this.selectedIds.add(id);
            el.classList.add('selected');
        }
        this.updateSelectionUI();
    }

    updateSelectionUI() {
        const bar = document.getElementById('selectionBar');
        const count = document.getElementById('selectCount');
        const mergeBtn = document.getElementById('mergeSelected');
        const splitBtn = document.getElementById('splitSelected');

        if (this.selectedIds.size > 0) {
            bar.classList.add('active');
            count.textContent = `${this.selectedIds.size}`;
            mergeBtn.style.display = this.selectedIds.size > 1 ? 'inline-flex' : 'none';
            splitBtn.style.display = this.selectedIds.size === 1 ? 'inline-flex' : 'none';
        } else {
            bar.classList.remove('active');
        }
    }

    clearSelection() {
        this.selectedIds.forEach(id => {
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) el.classList.remove('selected');
        });
        this.selectedIds.clear();
        this.updateSelectionUI();
    }

    bulkDelete() {
        if (!confirm(`Delete ${this.selectedIds.size} cards?`)) return;
        this.pushHistory("Bulk Delete");
        this.selectedIds.forEach(id => {
            this.cards = this.cards.filter(c => c.id !== id);
            const el = document.querySelector(`.flip-card[data-id="${id}"]`);
            if (el) el.remove();
        });
        this.clearSelection();
        this.saveState();
        if (this.cards.length === 0) {
            this.renderAll();
        }
    }

    openFullscreen(id) {
        const card = this.cards.find(c => c.id === id);
        if (!card) return;

        this.fullscreenId = id;
        this.fsFlipped = false;

        const headerTitle = document.querySelector('.fs-header h3');
        if (headerTitle) headerTitle.textContent = `Response: ${card.q.substring(0, 50)}...`;

        const requestPane = document.getElementById('fsRequestPane');
        const requestContent = document.getElementById('fsRequest');
        requestContent.innerHTML = this.md(card.q);
        requestPane.style.display = 'none';

        const responseContent = document.getElementById('fsResponse');
        if (card.r === '...' && this.streamingId === id) {
            responseContent.innerHTML = '<div class="streaming"><span class="thinking-indicator">Thinking...</span><button class="stop-stream-btn" onclick="app.stopStream()">Stop</button></div>';
        } else {
            responseContent.innerHTML = this.md(card.r);
        }

        const ov = document.getElementById('fullscreenOverlay');
        ov.classList.add('active');
        
        setTimeout(() => {
            const responsePane = document.getElementById('fsResponsePane');
            if (responsePane) responsePane.scrollTop = responsePane.scrollHeight;
        }, 50);
    }

    closeFullscreen() {
        document.getElementById('fullscreenOverlay').classList.remove('active');
        this.fullscreenId = null;
    }

    toggleFullscreenFlip() {
        if (!this.fullscreenId) return;
        this.fsFlipped = !this.fsFlipped;
        const requestPane = document.getElementById('fsRequestPane');
        const responsePane = document.getElementById('fsResponsePane');
        
        if (this.fsFlipped) {
            requestPane.style.display = 'block';
            responsePane.style.display = 'none';
        } else {
            requestPane.style.display = 'none';
            responsePane.style.display = 'block';
        }
    }

    toggleNativeFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch((e) => {
                this.showToast("Fullscreen blocked by browser");
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            }
        }
    }
    
    readCurrentFullscreen() {
        if (this.fullscreenId) this.readCard(this.fullscreenId);
    }

    setCardView(view) {
        this.settings.view = view;
        document.body.className = ''; 
        if (view === 'grid') document.body.classList.add('view-grid');
        if (view === 'list') document.body.classList.add('view-list');
        if (view === 'full') document.body.classList.add('view-full');
        this.saveState();
    }

    cycleView() {
        const views = ['list', 'grid', 'full'];
        const next = views[(views.indexOf(this.settings.view) + 1) % views.length];
        this.setCardView(next);
        this.showToast(`View: ${next.toUpperCase()}`);
    }

    applyView() {
        this.setCardView(this.settings.view);
    }

    toggleThemeMode() {
        const current = document.body.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';
        document.body.setAttribute('data-theme', next);
        if (next === 'light') {
            this.theme.bg = '#f8f9fa'; this.theme.cardBg = '#ffffff'; this.theme.text = '#222'; this.theme.border = '#ddd';
        } else {
            this.theme.bg = '#121212'; this.theme.cardBg = '#1e1e1e'; this.theme.text = '#f5f5f5'; this.theme.border = '#333';
        }
        this.applyTheme();
        this.saveState();
    }

    toggleThemeLock() {
        this.theme.locked = !this.theme.locked;
        document.getElementById('lockLabel').textContent = this.theme.locked ? "Theme Locked" : "Lock Theme";
        this.showToast(this.theme.locked ? "Global Theme Locked" : "Global Theme Unlocked");
        this.saveState();
    }

    saveAppearance() {
        const proxyInput = document.getElementById('proxyUrlInput');
        if (proxyInput && proxyInput.value.trim()) {
            this.settings.proxyUrl = proxyInput.value.trim();
            this.saveState();
        }
        
        this.pushHistory("Appearance Save");
        this.showToast("Appearance Saved");
    }

    applyTheme() {
        const r = document.documentElement.style;
        r.setProperty('--primary', this.theme.primary);
        r.setProperty('--bg', this.theme.bg);
        r.setProperty('--card-bg', this.theme.cardBg);
        r.setProperty('--text', this.theme.text);
        r.setProperty('--border', this.theme.border);
        const brand = document.getElementById('brandPlaceholder');
        if (brand) brand.textContent = this.theme.name || 'ai-Ndraft';
    }

    initASR() {
        if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.lang = 'en-US';
            this.recognition.interimResults = false;

            this.recognition.onstart = () => {
                this.isListening = true;
                const btn = document.getElementById('sendBtn');
                btn.innerHTML = '<i class="fas fa-stop"></i>';
                btn.classList.add('listening');
                btn.title = "Stop Listening";
            };

            this.recognition.onend = () => {
                this.isListening = false;
                const btn = document.getElementById('sendBtn');
                btn.innerHTML = '⏎';
                btn.classList.remove('listening');
                btn.title = "Send";
            };

            this.recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                document.getElementById('userInput').value = transcript;
            };
        }
    }

    toggleASR() {
        this.settings.asrEnabled = !this.settings.asrEnabled;
        this.updateToggles();
        this.saveState();
    }

    toggleTTS() {
        this.settings.autoTTS = !this.settings.autoTTS;
        this.updateToggles();
        this.saveState();
    }

    updateToggles() {
        const asrBtn = document.getElementById('asrToggle');
        const ttsBtn = document.getElementById('ttsToggle');
        if (asrBtn) asrBtn.classList.toggle('active', this.settings.asrEnabled);
        if (ttsBtn) ttsBtn.classList.toggle('active', this.settings.autoTTS);
    }

    readCard(id, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const card = this.cards.find(c => c.id === id);
        if (!card || !card.r) return;
        
        if (responsiveVoice.isPlaying()) {
            responsiveVoice.cancel();
        } else {
            const text = card.r.replace(/[#*_`>~-]/g, '').substring(0, 2000);
            responsiveVoice.speak(text, "US English Female", { rate: 1.1 });
        }
    }

    showToast(msg) {
        const t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
    }

    md(text) {
        if (!text) return '';
        try {
            return DOMPurify.sanitize(marked.parse(text));
        } catch (e) {
            console.error("Markdown parsing error", e);
            return text;
        }
    }
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    window.app.init();
});