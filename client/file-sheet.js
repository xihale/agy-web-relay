  function initMobileFileSheet() {
    const isMobilePickerEnv =
      window === window.top &&
      typeof HTMLInputElement !== 'undefined' &&
      HTMLInputElement.prototype &&
      (window.matchMedia?.('(pointer: coarse)')?.matches ||
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ''));

    if (!isMobilePickerEnv || window.__agyMobileFilePickerPatched) return;
    window.__agyMobileFilePickerPatched = true;
    const origInputClick = HTMLInputElement.prototype.click;
    const origElFocus = HTMLElement.prototype.focus;
    let isFileSheetOpen = false;
    let suppressEditableFocusUntil = 0;

    const isEditableEl = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return t !== 'file' && t !== 'button' && t !== 'submit' && t !== 'reset' && t !== 'checkbox' && t !== 'radio';
      }
      return Boolean(
        el.isContentEditable ||
        el.closest?.('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'),
      );
    };

    const blurActiveEditable = () => {
      try {
        const active = document.activeElement;
        if (isEditableEl(active)) active.blur();
        navigator?.virtualKeyboard?.hide?.();
      } catch {}
    };

    const armFocusSuppression = (ms = 800) => {
      suppressEditableFocusUntil = Math.max(suppressEditableFocusUntil, Date.now() + ms);
      blurActiveEditable();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(blurActiveEditable);
      }
    };

    HTMLElement.prototype.focus = function(...args) {
      try {
        if ((isFileSheetOpen || Date.now() < suppressEditableFocusUntil) && isEditableEl(this)) {
          return;
        }
      } catch {}
      return origElFocus.apply(this, args);
    };

    document.addEventListener(
      'pointerdown',
      (ev) => {
        try {
          if (!isFileSheetOpen && isEditableEl(ev.target)) {
            suppressEditableFocusUntil = 0;
          }
        } catch {}
      },
      true,
    );

    // Avoid */*, image/*, video/*, audio/*, .ts (video/mp2ts) and .svg (image/svg+xml)
    // so Chrome Android opens DocumentsUI directly instead of showing Camera/Camcorder/Recorder chooser
    const DOC_FILE_ACCEPT =
      'application/*,text/*,application/octet-stream,.pdf,.txt,.md,.markdown,.json,.csv,.tsv,.xml,.yaml,.yml,.toml,.ini,.cfg,.conf,.log,.py,.js,.mjs,.cjs,.jsx,.tsx,.go,.rs,.java,.kt,.kts,.c,.cpp,.cc,.h,.hpp,.cs,.rb,.php,.swift,.sh,.bash,.sql,.html,.htm,.css,.scss,.zip,.tar,.gz,.7z,.rar,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.apk,.bin';

    const makeSvgIcon = (kind) => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.65');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const addEl = (tag, attrs) => {
        const node = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        svg.appendChild(node);
      };
      if (kind === 'photo') {
        addEl('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' });
        addEl('circle', { cx: '9', cy: '9', r: '2' });
        addEl('path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' });
      } else if (kind === 'video') {
        addEl('path', { d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5' });
        addEl('rect', { x: '2', y: '6', width: '14', height: '12', rx: '2' });
      } else if (kind === 'camera') {
        addEl('path', { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z' });
        addEl('circle', { cx: '12', cy: '13', r: '3' });
      } else {
        addEl('path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' });
        addEl('path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' });
      }
      return svg;
    };

    const openMobileFileSheet = (input) => {
      const existing = document.getElementById('agy-relay-file-sheet-backdrop');
      if (existing) existing.remove();
      if (!document.body) {
        armFocusSuppression(850);
        origInputClick.call(input);
        return;
      }

      const prevAccept = input.getAttribute('accept');
      const prevCapture = input.getAttribute('capture');
      isFileSheetOpen = true;
      armFocusSuppression(900);

      const backdrop = document.createElement('div');
      backdrop.id = 'agy-relay-file-sheet-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      const sheet = document.createElement('div');
      sheet.id = 'agy-relay-file-sheet';

      const grabber = document.createElement('div');
      grabber.className = 'agy-relay-sheet-grabber';
      const grabberBar = document.createElement('div');
      grabberBar.className = 'agy-relay-sheet-grabber-bar';
      grabber.appendChild(grabberBar);

      const group = document.createElement('div');
      group.className = 'agy-relay-sheet-group';

      const title = document.createElement('div');
      title.className = 'agy-relay-sheet-title';
      title.textContent = 'Files';
      group.appendChild(title);

      let closed = false;
      const closeSheet = () => {
        if (closed) return;
        closed = true;
        isFileSheetOpen = false;
        armFocusSuppression(450);
        document.removeEventListener('keydown', onKeyDown, true);
        backdrop.dataset.visible = '0';
        sheet.style.transform = '';
        setTimeout(() => backdrop.remove(), 220);
      };

      const onKeyDown = (ev) => {
        if (ev.key === 'Escape') closeSheet();
      };
      document.addEventListener('keydown', onKeyDown, true);

      const restoreAttrs = () => {
        if (prevAccept === null) input.removeAttribute('accept');
        else input.setAttribute('accept', prevAccept);
        if (prevCapture === null) input.removeAttribute('capture');
        else input.setAttribute('capture', prevCapture);
      };

      const pickWith = (acceptVal, captureVal) => {
        if (acceptVal) input.setAttribute('accept', acceptVal);
        else input.removeAttribute('accept');
        if (captureVal) input.setAttribute('capture', captureVal);
        else input.removeAttribute('capture');

        const cleanup = () => {
          input.removeEventListener('change', cleanup);
          input.removeEventListener('cancel', cleanup);
          window.removeEventListener('focus', onWinFocus);
          armFocusSuppression(450);
          restoreAttrs();
        };
        const onWinFocus = () => {
          armFocusSuppression(550);
          setTimeout(cleanup, 600);
        };
        input.addEventListener('change', cleanup, { once: true });
        input.addEventListener('cancel', cleanup, { once: true });
        window.addEventListener('focus', onWinFocus, { once: true });

        closeSheet();
        armFocusSuppression(900);
        origInputClick.call(input);
      };

      const options = [
        { icon: 'photo', label: '相册照片', accept: 'image/*', capture: '' },
        { icon: 'video', label: '相册视频', accept: 'video/*', capture: '' },
        { icon: 'camera', label: '相机拍照', accept: 'image/*', capture: 'environment' },
        { icon: 'file', label: '本地文件', accept: DOC_FILE_ACCEPT, capture: '' },
      ];

      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agy-relay-sheet-btn';
        const labelSpan = document.createElement('span');
        labelSpan.textContent = opt.label;
        btn.append(makeSvgIcon(opt.icon), labelSpan);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          pickWith(opt.accept, opt.capture);
        });
        group.appendChild(btn);
      }

      let dragStartY = 0;
      let dragDeltaY = 0;
      sheet.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        dragStartY = e.touches[0].clientY;
        dragDeltaY = 0;
        sheet.style.transition = 'none';
      }, { passive: true });
      sheet.addEventListener('touchmove', (e) => {
        if (!dragStartY || e.touches.length !== 1) return;
        dragDeltaY = Math.max(0, e.touches[0].clientY - dragStartY);
        if (dragDeltaY > 0) {
          sheet.style.transform = 'translateY(' + dragDeltaY + 'px)';
        }
      }, { passive: true });
      const endDrag = () => {
        if (!dragStartY) return;
        dragStartY = 0;
        sheet.style.transition = '';
        if (dragDeltaY > 72) {
          closeSheet();
        } else {
          sheet.style.transform = '';
        }
        dragDeltaY = 0;
      };
      sheet.addEventListener('touchend', endDrag, { passive: true });
      sheet.addEventListener('touchcancel', endDrag, { passive: true });

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeSheet();
      });

      sheet.append(grabber, group);
      backdrop.appendChild(sheet);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => {
        backdrop.dataset.visible = '1';
      });
    };

    HTMLInputElement.prototype.click = function(...args) {
      try {
        if (this && this.type === 'file') {
          armFocusSuppression(900);
          if (
            !this.hasAttribute('webkitdirectory') &&
            (!this.getAttribute('accept') || this.getAttribute('accept').trim() === '')
          ) {
            openMobileFileSheet(this);
            return;
          }
        }
      } catch {}
      return origInputClick.apply(this, args);
    };
  }
