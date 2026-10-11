/*
 * Arms the scroll reveals (see "Motion" in styles.css). The page is complete without this file: the stylesheet may hide a
 * `[data-reveal]` block only once `html[data-reveal-ready]` exists, and this script is the only thing that sets it. If the
 * script fails to load, or the browser has no IntersectionObserver, nothing is ever hidden.
 */
;(function (window, document) {
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
})(window, document)
