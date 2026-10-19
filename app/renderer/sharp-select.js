(() => {
  'use strict';

  const components = new Map();
  let openComponent = null;
  let nextId = 0;

  function optionText(option) {
    return String(option?.textContent || '').trim();
  }

  function isEnabled(item) {
    return !!item && !item.disabled;
  }

  function selectedItemIndex(component) {
    return component.items.findIndex((item) => item.optionIndex === component.select.selectedIndex);
  }

  function setActive(component, index, scroll = true) {
    if (!component.items.length) return;
    if (!isEnabled(component.items[index])) return;

    component.items.forEach((item, itemIndex) => {
      item.element.classList.toggle('is-active', itemIndex === index);
    });
    component.activeIndex = index;
    if (component.menu.hidden) component.trigger.removeAttribute('aria-activedescendant');
    else component.trigger.setAttribute('aria-activedescendant', component.items[index].element.id);
    if (scroll) component.items[index].element.scrollIntoView({ block: 'nearest' });
  }

  function moveActive(component, direction) {
    const count = component.items.length;
    if (!count) return;

    let index = component.activeIndex;
    for (let attempts = 0; attempts < count; attempts += 1) {
      index = (index + direction + count) % count;
      if (isEnabled(component.items[index])) {
        setActive(component, index);
        return;
      }
    }
  }

  function moveToEdge(component, fromEnd) {
    const start = fromEnd ? component.items.length - 1 : 0;
    const step = fromEnd ? -1 : 1;
    for (let index = start; index >= 0 && index < component.items.length; index += step) {
      if (isEnabled(component.items[index])) {
        setActive(component, index);
        return;
      }
    }
  }

  function updateTrigger(component) {
    const selected = component.select.options[component.select.selectedIndex] || null;
    component.value.textContent = selected ? optionText(selected) : '';
    component.trigger.disabled = component.select.disabled;
    component.trigger.setAttribute('aria-disabled', String(component.select.disabled));
    if (component.select.disabled && openComponent === component) close(component);
  }

  function createOption(component, option, optionIndex, groupDisabled = false) {
    const element = document.createElement('div');
    const itemIndex = component.items.length;
    const disabled = component.select.disabled || groupDisabled || option.disabled;

    element.id = `${component.menu.id}-option-${optionIndex}`;
    element.className = 'sharp-select__option';
    element.setAttribute('role', 'option');
    element.setAttribute('aria-selected', String(optionIndex === component.select.selectedIndex));
    element.setAttribute('aria-disabled', String(disabled));
    element.textContent = optionText(option);
    if (disabled) element.classList.add('is-disabled');

    const item = { element, option, optionIndex, disabled };
    component.items.push(item);

    element.addEventListener('pointerdown', (event) => event.preventDefault());
    element.addEventListener('pointermove', () => {
      if (!disabled) setActive(component, itemIndex, false);
    });
    element.addEventListener('click', (event) => {
      event.preventDefault();
      choose(component, itemIndex);
    });
    return element;
  }

  function rebuild(component) {
    const { select, menu } = component;
    const nativeOptions = Array.from(select.options);
    menu.replaceChildren();
    component.items = [];

    Array.from(select.children).forEach((child) => {
      if (child.tagName === 'OPTGROUP') {
        const group = document.createElement('div');
        group.className = 'sharp-select__group';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', child.label || '');

        const label = document.createElement('div');
        label.className = 'sharp-select__group-label';
        label.textContent = child.label || '';
        label.setAttribute('aria-hidden', 'true');
        group.appendChild(label);

        Array.from(child.children).forEach((option) => {
          if (option.tagName !== 'OPTION' || option.hidden) return;
          group.appendChild(createOption(
            component,
            option,
            nativeOptions.indexOf(option),
            child.disabled
          ));
        });
        menu.appendChild(group);
        return;
      }

      if (child.tagName === 'OPTION' && !child.hidden) {
        menu.appendChild(createOption(component, child, nativeOptions.indexOf(child)));
      }
    });

    updateTrigger(component);
    const selectedIndex = selectedItemIndex(component);
    component.activeIndex = -1;
    if (selectedIndex >= 0 && isEnabled(component.items[selectedIndex])) {
      setActive(component, selectedIndex, false);
    } else {
      moveToEdge(component, false);
    }
  }

  function positionMenu(component) {
    if (component.menu.hidden) return;
    const margin = 8;
    const gap = 2;
    const preferredHeight = 320;
    const rect = component.trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - margin - gap;
    const spaceAbove = rect.top - margin - gap;
    const openAbove = spaceBelow < 150 && spaceAbove > spaceBelow;
    const available = Math.max(84, openAbove ? spaceAbove : spaceBelow);
    const maxHeight = Math.min(preferredHeight, available);
    const width = Math.min(rect.width, window.innerWidth - (margin * 2));
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);

    component.menu.style.width = `${width}px`;
    component.menu.style.maxHeight = `${maxHeight}px`;
    component.menu.style.left = `${left}px`;
    component.menu.classList.toggle('opens-up', openAbove);

    if (openAbove) {
      const height = Math.min(component.menu.scrollHeight, maxHeight);
      component.menu.style.top = `${Math.max(margin, rect.top - gap - height)}px`;
    } else {
      component.menu.style.top = `${Math.min(window.innerHeight - margin, rect.bottom + gap)}px`;
    }
  }

  function close(component, { restoreFocus = false } = {}) {
    if (!component) return;
    resetTypeahead(component);
    if (component.menu.hidden) {
      component.trigger.removeAttribute('aria-activedescendant');
      return;
    }
    component.wrapper.classList.remove('is-open');
    component.trigger.setAttribute('aria-expanded', 'false');
    component.trigger.removeAttribute('aria-activedescendant');
    component.menu.hidden = true;
    if (openComponent === component) openComponent = null;
    if (restoreFocus) component.trigger.focus();
  }

  function closeAll() {
    if (openComponent) close(openComponent);
  }

  function open(component) {
    if (component.select.disabled) return;
    if (openComponent && openComponent !== component) close(openComponent);
    resetTypeahead(component);

    rebuild(component);
    component.menu.hidden = false;
    component.wrapper.classList.add('is-open');
    component.trigger.setAttribute('aria-expanded', 'true');
    openComponent = component;
    positionMenu(component);

    const selectedIndex = selectedItemIndex(component);
    if (selectedIndex >= 0 && isEnabled(component.items[selectedIndex])) {
      setActive(component, selectedIndex);
    } else {
      moveToEdge(component, false);
    }
  }

  function choose(component, itemIndex) {
    const item = component.items[itemIndex];
    if (!isEnabled(item)) return;

    const changed = component.select.selectedIndex !== item.optionIndex;
    component.select.selectedIndex = item.optionIndex;
    updateTrigger(component);
    close(component, { restoreFocus: true });

    if (changed) {
      component.select.dispatchEvent(new Event('input', { bubbles: true }));
      component.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function resetTypeahead(component) {
    window.clearTimeout(component.typeaheadTimer);
    component.typeaheadText = '';
    component.typeaheadTimer = null;
  }

  function runTypeahead(component, key) {
    window.clearTimeout(component.typeaheadTimer);
    const normalizedKey = key.toLocaleLowerCase();
    const repeatedCharacter = component.typeaheadText
      && Array.from(component.typeaheadText).every((character) => character === normalizedKey);
    component.typeaheadText = repeatedCharacter
      ? normalizedKey
      : `${component.typeaheadText}${normalizedKey}`;
    component.typeaheadTimer = window.setTimeout(() => {
      component.typeaheadText = '';
      component.typeaheadTimer = null;
    }, 700);

    if (component.menu.hidden) open(component);
    const count = component.items.length;
    const start = component.activeIndex >= 0 ? component.activeIndex + 1 : 0;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (start + offset) % count;
      const item = component.items[index];
      if (isEnabled(item) && optionText(item.option).toLocaleLowerCase().startsWith(component.typeaheadText)) {
        setActive(component, index);
        return;
      }
    }
  }

  function onKeyDown(component, event) {
    const isOpen = !component.menu.hidden;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) open(component);
      else moveActive(component, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!isOpen) open(component);
      moveToEdge(component, event.key === 'End');
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!isOpen) open(component);
      else choose(component, component.activeIndex);
      return;
    }
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      close(component, { restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      close(component);
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      runTypeahead(component, event.key);
    }
  }

  function scheduleRefresh(component) {
    if (component.refreshScheduled) return;
    component.refreshScheduled = true;
    queueMicrotask(() => {
      component.refreshScheduled = false;
      rebuild(component);
      if (!component.menu.hidden) positionMenu(component);
    });
  }

  function enhance(select) {
    if (!select || select.tagName !== 'SELECT' || components.has(select)) return components.get(select);

    nextId += 1;
    const originalId = select.id || `sharp-select-native-${nextId}`;
    if (!select.id) select.id = originalId;

    const wrapper = document.createElement('div');
    wrapper.className = 'sharp-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${originalId}-sharp-trigger`;
    trigger.className = 'sharp-select__trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const value = document.createElement('span');
    value.className = 'sharp-select__value';
    trigger.appendChild(value);

    const chevron = document.createElement('span');
    chevron.className = 'sharp-select__chevron';
    chevron.setAttribute('aria-hidden', 'true');
    trigger.appendChild(chevron);
    wrapper.appendChild(trigger);

    const menu = document.createElement('div');
    menu.id = `${originalId}-sharp-listbox`;
    menu.className = 'sharp-select__popup';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    (select.closest('dialog') || document.body).appendChild(menu);
    trigger.setAttribute('aria-controls', menu.id);

    const labels = Array.from(document.querySelectorAll('label[for]'))
      .filter((label) => label.getAttribute('for') === originalId);
    if (labels[0] && !labels[0].id) labels[0].id = `${originalId}-sharp-label`;
    labels.forEach((label) => { label.htmlFor = trigger.id; });
    if (labels[0]?.id) {
      trigger.setAttribute('aria-labelledby', labels[0].id);
      menu.setAttribute('aria-labelledby', labels[0].id);
    } else {
      const accessibleName = labels[0]?.textContent.trim() || select.getAttribute('aria-label') || originalId;
      trigger.setAttribute('aria-label', accessibleName);
      menu.setAttribute('aria-label', accessibleName);
    }

    select.classList.add('sharp-select__native');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;

    const component = {
      select,
      wrapper,
      trigger,
      value,
      menu,
      items: [],
      activeIndex: -1,
      refreshScheduled: false,
      typeaheadText: '',
      typeaheadTimer: null,
      observer: null
    };
    components.set(select, component);

    trigger.addEventListener('click', () => {
      if (menu.hidden) open(component);
      else close(component, { restoreFocus: true });
    });
    trigger.addEventListener('keydown', (event) => onKeyDown(component, event));
    select.addEventListener('input', () => scheduleRefresh(component));
    select.addEventListener('change', () => scheduleRefresh(component));

    component.observer = new MutationObserver(() => scheduleRefresh(component));
    component.observer.observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'label', 'selected', 'hidden']
    });

    rebuild(component);
    return component;
  }

  function mountAll(root = document) {
    if (root?.tagName === 'SELECT') enhance(root);
    else root?.querySelectorAll?.('select').forEach(enhance);
  }

  function refresh(target) {
    if (!target) return;
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element) return;
    if (element.tagName === 'SELECT') {
      const component = components.get(element) || enhance(element);
      if (component) scheduleRefresh(component);
      return;
    }
    element.querySelectorAll?.('select').forEach((select) => {
      const component = components.get(select) || enhance(select);
      if (component) scheduleRefresh(component);
    });
  }

  function refreshAll() {
    mountAll(document);
    components.forEach((component) => scheduleRefresh(component));
  }

  document.addEventListener('pointerdown', (event) => {
    if (!openComponent) return;
    if (openComponent.wrapper.contains(event.target) || openComponent.menu.contains(event.target)) return;
    close(openComponent);
  }, true);

  document.addEventListener('scroll', (event) => {
    if (!openComponent || openComponent.menu === event.target || openComponent.menu.contains(event.target)) return;
    close(openComponent);
  }, true);
  window.addEventListener('resize', closeAll);

  window.SharpSelect = { mountAll, refresh, refreshAll, closeAll };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountAll(document), { once: true });
  } else {
    mountAll(document);
  }
})();
