/*
 * The page is complete without this file. It only adds four things, each of which does nothing if what it needs is missing:
 *
 *  1. Scroll reveals (see "Motion" in styles.css). The stylesheet may hide a `[data-reveal]` block only once
 *     `html[data-reveal-ready]` exists, and this script is the only thing that sets it: a script that fails to load, or a browser
 *     without IntersectionObserver, leaves nothing hidden.
 *  2. A Copy button next to the install line. The button ships `hidden`; it appears only where the clipboard can be written.
 *  3. The workflow diagram's detail panel, updated from localized SVG targets on hover, focus or tap.
 *  4. The demo clip: native controls are the baseline. Only after the custom Pause/Play control and motion preference are ready
 *     does this script hide the native controls; it autoplays only where motion is welcome and pauses while off screen.
 */
;(function (window, document) {
  function each(list, fn) {
    Array.prototype.forEach.call(list, fn)
  }

  function normalizeSearchValue(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  }

  function reveal() {
    if (!('IntersectionObserver' in window)) return

    var targets = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]:not(.is-visible)'))
    // Whatever is already on screen is marked visible before arming, so arming can never flash it away.
    var pending = targets.filter(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.9) {
        el.classList.add('is-visible')
        return false
      }
      return true
    })

    document.documentElement.dataset.revealReady = ''

    var observer = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        })
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    )
    pending.forEach(function (el) {
      observer.observe(el)
    })
  }

  function copy() {
    var clipboard = window.navigator && window.navigator.clipboard
    if (!clipboard || typeof clipboard.writeText !== 'function') return
    each(document.querySelectorAll('button.copy[data-copy]'), function (button) {
      var label = button.textContent
      var status = button.nextElementSibling
      var say = function (text) {
        if (status) status.textContent = text
      }
      button.hidden = false
      button.addEventListener('click', function () {
        clipboard.writeText(button.getAttribute('data-copy')).then(
          function () {
            var done = button.getAttribute('data-copied') || label
            button.textContent = done
            say(done)
            window.setTimeout(function () {
              button.textContent = label
            }, 1600)
          },
          function () {
            // A refusal is told, not swallowed: the line stays selectable.
            say(button.getAttribute('data-failed') || '')
          },
        )
      })
    })
  }

  function diagramExplorer() {
    each(document.querySelectorAll('[data-diagram-explorer]'), function (root) {
      var output = root.querySelector('[data-diagram-description]')
      if (!output) return
      var overview = output.getAttribute('data-default') || output.textContent

      function part(node) {
        return node && typeof node.closest === 'function' ? node.closest('[data-diagram-part]') : null
      }
      function show(node) {
        if (node) output.textContent = node.getAttribute('data-diagram-detail') || overview
      }
      function reset() {
        output.textContent = overview
      }

      root.addEventListener('pointerover', function (event) {
        show(part(event.target))
      })
      root.addEventListener('pointerout', function (event) {
        if (event.pointerType === 'touch') return
        var current = part(event.target)
        var next = part(event.relatedTarget)
        if (next) {
          show(next)
          return
        }
        if (current) reset()
      })
      root.addEventListener('focusin', function (event) {
        show(part(event.target))
      })
      root.addEventListener('focusout', function (event) {
        var next = part(event.relatedTarget)
        if (next) show(next)
        else if (part(event.target)) reset()
      })
      root.addEventListener('click', function (event) {
        show(part(event.target))
      })
      root.addEventListener('keydown', function (event) {
        var target = part(event.target)
        if (!target || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        show(target)
      })
    })
  }

  function video() {
    each(document.querySelectorAll('video[data-motion]'), function (clip) {
      var toggle = clip.nextElementSibling
      if (!toggle || typeof toggle.addEventListener !== 'function'
        || typeof clip.play !== 'function' || typeof clip.pause !== 'function'
        || typeof window.matchMedia !== 'function') return

      var reduce
      try {
        reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
      } catch (_) {
        return
      }
      if (!reduce || typeof reduce.matches !== 'boolean' || typeof reduce.addEventListener !== 'function') return

      var userPaused = false
      var visible = true

      function label() {
        if (toggle) toggle.textContent = clip.paused ? toggle.getAttribute('data-play') : toggle.getAttribute('data-pause')
      }
      function play() {
        var started = clip.play()
        if (started && typeof started.catch === 'function') {
          started.catch(function () {
            // Whatever stopped it, the button now says Play and is the way to start it.
            label()
          })
        }
        label()
      }
      function settle() {
        if (toggle) toggle.hidden = false
        if (reduce && reduce.matches) {
          clip.pause()
          label()
          return
        }
        if (visible && !userPaused) play()
        else label()
      }

      if (toggle) {
        toggle.addEventListener('click', function () {
          if (clip.paused) {
            userPaused = false
            play()
          } else {
            userPaused = true
            clip.pause()
            label()
          }
        })
      }
      reduce.addEventListener('change', settle)

      // The button is now wired and reduced-motion is known, so the custom control can safely replace the native one.
      clip.controls = false
      toggle.hidden = false

      // Only while it is on screen: a looping clip nobody can see should not spend the battery.
      if ('IntersectionObserver' in window) {
        new window.IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            visible = entry.isIntersecting
            if (reduce && reduce.matches) return
            if (!visible) {
              clip.pause()
              label()
            } else if (!userPaused) play()
          })
        }).observe(clip)
      }
      settle()
    })
  }

  function docsSearch() {
    each(document.querySelectorAll('[data-docs-search]'), function (root) {
      var form = root.querySelector('[data-docs-search] form') || root.querySelector('form')
      var query = root.querySelector('input[type="search"]')
      var version = root.querySelector('select[name="version"]')
      var status = root.querySelector('[data-search-status]')
      var results = root.querySelector('[data-search-results]')
      if (!form || !query || !version || !status || !results || typeof window.fetch !== 'function') return

      function setUrl(push) {
        if (!window.URL || !window.history) return
        var url = new window.URL(window.location.href)
        if (query.value.trim()) url.searchParams.set('q', query.value.trim())
        else url.searchParams.delete('q')
        if (version.value !== 'current') url.searchParams.set('version', version.value)
        else url.searchParams.delete('version')
        if (push) window.history.pushState({}, '', url)
        else window.history.replaceState({}, '', url)
      }
      function render() {
        var terms = normalizeSearchValue(query.value).split(/\s+/).filter(Boolean)
        var selectedVersion = version.value
        results.replaceChildren()
        if (terms.length === 0) {
          status.textContent = root.getAttribute('data-empty') || ''
          return
        }
        var matches = entries.filter(function (entry) {
          if (selectedVersion !== 'all' && selectedVersion !== entry.version) return false
          var haystack = normalizeSearchValue([entry.title, entry.section, entry.text].join(' '))
          return terms.every(function (term) { return haystack.indexOf(term) !== -1 })
        }).slice(0, 30)
        if (matches.length === 0) {
          status.textContent = root.getAttribute('data-no-results') || ''
          return
        }
        var countText = root.getAttribute(matches.length === 1 ? 'data-count-one' : 'data-count-many') || '{count}'
        status.textContent = countText.replace('{count}', String(matches.length))
        matches.forEach(function (entry) {
          var item = document.createElement('li')
          var link = document.createElement('a')
          var details = document.createElement('p')
          var excerpt = document.createElement('p')
          var source = document.createElement('span')
          var target
          try {
            target = new window.URL(entry.href, window.location.href)
          } catch (_) {
            return
          }
          if (target.origin !== window.location.origin) return
          link.href = target.pathname + target.search + target.hash
          link.textContent = entry.section || entry.title
          details.textContent = entry.title + ' · ' + entry.version
          excerpt.textContent = String(entry.text || '').slice(0, 220)
          if (root.getAttribute('data-lang') === 'vi' && entry.lang === 'en') {
            source.className = 'docs-search__source'
            source.textContent = root.getAttribute('data-english-source') || ''
          }
          item.appendChild(link)
          item.appendChild(details)
          item.appendChild(excerpt)
          if (source.textContent) item.appendChild(source)
          results.appendChild(item)
        })
      }
      var entries = []
      window.fetch(root.getAttribute('data-search-index'), { credentials: 'same-origin' }).then(function (response) {
        if (!response || !response.ok) throw new Error('index unavailable')
        return response.json()
      }).then(function (data) {
        if (!Array.isArray(data) || !data.every(function (entry) {
          return entry && typeof entry.title === 'string' && typeof entry.section === 'string' && typeof entry.text === 'string' && typeof entry.href === 'string' && typeof entry.version === 'string'
        })) throw new Error('invalid index')
        entries = data
        var params = new window.URL(window.location.href).searchParams
        query.value = params.get('q') || ''
        var selected = params.get('version') || 'current'
        version.value = Array.prototype.some.call(version.options || [], function (option) { return option.value === selected }) ? selected : 'current'
        root.hidden = false
        form.addEventListener('submit', function (event) {
          event.preventDefault()
          setUrl(true)
          render()
        })
        query.addEventListener('input', function () { setUrl(false); render() })
        version.addEventListener('change', function () { setUrl(false); render() })
        window.addEventListener('popstate', function () {
          var current = new window.URL(window.location.href).searchParams
          query.value = current.get('q') || ''
          var desired = current.get('version') || 'current'
          version.value = Array.prototype.some.call(version.options || [], function (option) { return option.value === desired }) ? desired : 'current'
          render()
        })
        render()
      }).catch(function () {
        root.hidden = false
        form.hidden = true
        status.textContent = root.getAttribute('data-error') || ''
      })
    })
  }

  function changelogExplorer() {
    each(document.querySelectorAll('[data-changelog]'), function (root) {
      var form = root.querySelector('form')
      var query = root.querySelector('input[type="search"]')
      var version = root.querySelector('select[name="version"]')
      var category = root.querySelector('select[name="type"]')
      var status = root.querySelector('[data-changelog-status]')
      var pageStatus = root.querySelector('[data-page-status]')
      var previous = root.querySelector('[data-page-previous]')
      var next = root.querySelector('[data-page-next]')
      var releases = Array.prototype.slice.call(document.querySelectorAll('[data-release]'))
      var releaseLinks = document.querySelectorAll('.changelog__index a[href^="#"]')
      if (!form || !query || !version || !category || !status || !pageStatus || !previous || !next || releases.length === 0) return
      var entries = releases.map(function (section) {
        return {
          element: section,
          tag: section.getAttribute('data-version') || '',
          categories: (section.getAttribute('data-categories') || '').split(/\s+/).filter(Boolean),
          text: section.getAttribute('data-search') || '',
          href: '#' + (section.id || ''),
        }
      })
      var page = 1
      var pageSize = 3

      function readState() {
        var params = new window.URL(window.location.href).searchParams
        query.value = params.get('q') || ''
        var wantedVersion = params.get('version') || 'all'
        var wantedCategory = params.get('type') || 'all'
        version.value = Array.prototype.some.call(version.options || [], function (option) { return option.value === wantedVersion }) ? wantedVersion : 'all'
        category.value = Array.prototype.some.call(category.options || [], function (option) { return option.value === wantedCategory }) ? wantedCategory : 'all'
        var requested = Number(params.get('page') || 1)
        page = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1
      }
      function writeState(push, anchor) {
        var url = new window.URL(window.location.href)
        if (query.value.trim()) url.searchParams.set('q', query.value.trim())
        else url.searchParams.delete('q')
        if (version.value !== 'all') url.searchParams.set('version', version.value)
        else url.searchParams.delete('version')
        if (category.value !== 'all') url.searchParams.set('type', category.value)
        else url.searchParams.delete('type')
        if (page > 1) url.searchParams.set('page', String(page))
        else url.searchParams.delete('page')
        url.hash = anchor || ''
        if (push) window.history.pushState({}, '', url)
        else window.history.replaceState({}, '', url)
      }
      function filter() {
        var terms = normalizeSearchValue(query.value).split(/\s+/).filter(Boolean)
        return entries.filter(function (entry) {
          if (version.value !== 'all' && version.value !== entry.tag) return false
          if (category.value !== 'all' && entry.categories.indexOf(category.value) === -1) return false
          var text = normalizeSearchValue(entry.tag + ' ' + entry.text)
          return terms.every(function (term) { return text.indexOf(term) !== -1 })
        })
      }
      function render(scrollToId) {
        var matching = filter()
        var pages = Math.max(1, Math.ceil(matching.length / pageSize))
        page = Math.max(1, Math.min(pages, page))
        var visible = matching.slice((page - 1) * pageSize, page * pageSize)
        var visibleSet = new Set(visible)
        entries.forEach(function (entry) { entry.element.hidden = !visibleSet.has(entry) })
        status.textContent = matching.length === 0
          ? (root.getAttribute('data-no-results') || '')
          : (root.getAttribute('data-result-template') || '{count}').replace('{count}', String(matching.length))
        pageStatus.textContent = (root.getAttribute('data-page-template') || '{page}/{pages} · {count}')
          .replace('{page}', String(page)).replace('{pages}', String(pages)).replace('{count}', String(matching.length))
        previous.disabled = page <= 1
        next.disabled = page >= pages
        if (scrollToId) {
          var target = document.getElementById(scrollToId)
          if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView()
        }
      }
      function setPageForAnchor(id) {
        var target = entries.filter(function (entry) { return entry.element.id === id })[0]
        if (!target) return false
        var matching = filter()
        var index = matching.indexOf(target)
        if (index < 0) {
          query.value = ''
          version.value = 'all'
          category.value = 'all'
          matching = entries
          index = matching.indexOf(target)
        }
        page = Math.floor(index / pageSize) + 1
        return true
      }
      root.hidden = false
      readState()
      var initialHash = new window.URL(window.location.href).hash.slice(1)
      if (initialHash) setPageForAnchor(initialHash)
      if (initialHash) writeState(false, initialHash)
      form.addEventListener('submit', function (event) {
        event.preventDefault()
        page = 1
        writeState(true)
        render()
      })
      query.addEventListener('input', function () { page = 1; writeState(false); render() })
      version.addEventListener('change', function () { page = 1; writeState(false); render() })
      category.addEventListener('change', function () { page = 1; writeState(false); render() })
      previous.addEventListener('click', function () { page = Math.max(1, page - 1); writeState(true); render() })
      next.addEventListener('click', function () { page++; writeState(true); render() })
      each(releaseLinks, function (link) {
        link.addEventListener('click', function (event) {
          var id = (link.getAttribute('href') || '').slice(1)
          if (!setPageForAnchor(id)) return
          event.preventDefault()
          writeState(true, id)
          render(id)
        })
      })
      window.addEventListener('popstate', function () {
        readState()
        var hash = new window.URL(window.location.href).hash.slice(1)
        if (hash) setPageForAnchor(hash)
        if (hash) writeState(false, hash)
        render(hash)
      })
      render(initialHash)
    })
  }

  reveal()
  copy()
  diagramExplorer()
  video()
  docsSearch()
  changelogExplorer()
})(window, document)
