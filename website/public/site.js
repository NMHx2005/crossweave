/*
 * The page is complete without this file. It only adds three things, each of which does nothing if what it needs is missing:
 *
 *  1. Scroll reveals (see "Motion" in styles.css). The stylesheet may hide a `[data-reveal]` block only once
 *     `html[data-reveal-ready]` exists, and this script is the only thing that sets it: a script that fails to load, or a browser
 *     without IntersectionObserver, leaves nothing hidden.
 *  2. A Copy button next to the install line. The button ships `hidden`; it appears only where the clipboard can be written.
 *  3. The demo clip: it plays by itself, muted and looping, with no browser controls. This script adds a Pause/Play button and
 *     pauses the clip while it is off screen; where the reader asked for reduced motion it is paused on its poster, and the button
 *     is how they start it.
 */
;(function (window, document) {
  function each(list, fn) {
    Array.prototype.forEach.call(list, fn)
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

  function video() {
    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    each(document.querySelectorAll('video[data-motion]'), function (clip) {
      var toggle = clip.nextElementSibling
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
      if (reduce && typeof reduce.addEventListener === 'function') reduce.addEventListener('change', settle)

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

  reveal()
  copy()
  video()
})(window, document)
