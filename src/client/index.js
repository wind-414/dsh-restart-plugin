/**
 * Client half of the dsh-restart bundle.
 *
 * Renders a compact "restart DSH" pill in the sidebar footer, above the
 * account row. A click calls the Host route; the Host relaunches the app.
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-restart'
    const ROUTE = '/plugins/dsh-restart/restart'

    const EN = {
      label: 'Restart DSH',
      short: 'Restart',
      busy: 'Restarting\u2026',
      error: 'Restart failed',
      aria: 'Restart DeepSeek Harness',
      title: 'Restart the desktop app now',
    }

    const ZH = {
      label: '\u91cd\u542f DSH',
      short: '\u91cd\u542f',
      busy: '\u6b63\u5728\u91cd\u542f\u2026',
      error: '\u91cd\u542f\u5931\u8d25',
      aria: '\u91cd\u542f DeepSeek Harness',
      title: '\u7acb\u5373\u91cd\u542f\u684c\u9762\u5e94\u7528',
    }

    const CSS = [
      '.dr-root{display:inline-flex;align-items:center;justify-content:flex-start;width:100%;min-height:26px}',
      '.dr-chip{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;margin:0;padding:0 9px;border:1px solid #1c1c1c;border-radius:8px;background:#111;color:#fff;font-size:12px;line-height:1;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.16);transition:background-color .12s ease,color .12s ease}',
      '.dr-chip:hover{background:#000;color:#fff}',
      '.dr-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dr-chip[data-state="armed"]{color:#ffd27a;background:#111}',
      '.dr-chip[data-state="error"]{color:#ffb4b4}',
      '.dr-chip[data-state="busy"]{cursor:progress;color:#fff}',
      '.dr-icon{flex:none;width:14px;height:14px;display:inline-block;animation:none}',
      '.dr-chip[data-state="busy"] .dr-icon{animation:dr-spin .9s linear infinite}',
      '@keyframes dr-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion: reduce){.dr-chip[data-state="busy"] .dr-icon{animation:none}}',
    ].join('\n')

    function createEntry(ctx) {
      return function RestartDsh(props) {
        const t = ctx.locale.bind(NS)
        const wide = !props || props.wide !== false
        const [, bumpLocale] = React.useState(0)
        React.useEffect(() => ctx.locale.subscribe(() => bumpLocale(value => value + 1)), [])

        const [state, setState] = React.useState('idle')
        const resetTimer = React.useRef(null)

        React.useEffect(() => () => {
          if (resetTimer.current) clearTimeout(resetTimer.current)
        }, [])

        const fire = React.useCallback(async () => {
          setState('busy')
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json', 'x-dsh-restart': '1' },
              body: '{}',
            })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const data = await response.json()
            if (!data || data.ok !== true) throw new Error((data && data.reason) || 'failed')
          } catch {
            setState('error')
            if (resetTimer.current) clearTimeout(resetTimer.current)
            resetTimer.current = setTimeout(() => setState('idle'), 3000)
          }
        }, [])

        const onClick = () => {
          if (state === 'busy') return
          fire()
        }

        const label = state === 'busy' ? t('busy')
          : state === 'error' ? t('error')
            : t('label')

        return h(
          'div',
          { className: 'dr-root' },
          h('style', null, CSS),
          h(
            'button',
            {
              type: 'button',
              className: 'dr-chip',
              onClick,
              title: label + ' · ' + t('title'),
              'aria-label': t('aria'),
              'data-state': state,
            },
            h(
              'svg',
              {
                className: 'dr-icon',
                viewBox: '0 0 16 16',
                'aria-hidden': 'true',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              },
              h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
              h('path', { d: 'M13.2 2.6v3h-3' }),
            ),
            wide ? h('span', null, t('short')) : null,
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN))
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH))
        ctx.effect(() => ctx.locale.register(NS, 'zh-CN', ZH))

        const Entry = createEntry(ctx)
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-restart',
          order: 5,
          label: '\u91cd\u542f DSH',
        }, Entry))
      },
    }
  },
})
