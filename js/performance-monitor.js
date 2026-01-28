/**
 * 性能监控模块
 * 用于监控和记录应用加载性能指标
 */
class PerformanceMonitor {
    constructor() {
        this.metrics = {
            domContentLoaded: null,
            appInitialized: null,
            firstPaint: null,
            firstContentfulPaint: null,
            timeToInteractive: null
        };
        this.startTime = performance.now();
        this.init();
    }

    init() {
        // 记录 DOMContentLoaded 时间
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.metrics.domContentLoaded = performance.now();
                this.logMetric('DOMContentLoaded', this.metrics.domContentLoaded);
            });
        } else {
            this.metrics.domContentLoaded = performance.now();
            this.logMetric('DOMContentLoaded', this.metrics.domContentLoaded);
        }

        // 记录应用初始化时间
        window.addEventListener('appReady', () => {
            this.metrics.appInitialized = performance.now();
            this.logMetric('AppInitialized', this.metrics.appInitialized);
            this.calculateTimeToInteractive();
            this.printSummary();
        });

        // 记录首次绘制时间（使用 PerformanceObserver）
        this.observePaintTiming();
    }

    observePaintTiming() {
        if ('PerformanceObserver' in window) {
            try {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.name === 'first-paint') {
                            this.metrics.firstPaint = entry.startTime;
                            this.logMetric('FirstPaint', this.metrics.firstPaint);
                        }
                        if (entry.name === 'first-contentful-paint') {
                            this.metrics.firstContentfulPaint = entry.startTime;
                            this.logMetric('FirstContentfulPaint', this.metrics.firstContentfulPaint);
                        }
                    }
                });
                observer.observe({ type: 'paint', buffered: true });
            } catch (e) {
                // PerformanceObserver 可能在某些环境下不可用
                console.warn('[Performance] Paint timing not available');
            }
        }
    }

    logMetric(name, value) {
        if (value !== null && value !== undefined) {
            console.log(`⏱️ [Performance] ${name}: ${value.toFixed(2)}ms`);
        }
    }

    calculateTimeToInteractive() {
        if (this.metrics.domContentLoaded && this.metrics.appInitialized) {
            this.metrics.timeToInteractive = 
                this.metrics.appInitialized - this.metrics.domContentLoaded;
        }
    }

    printSummary() {
        console.log('\n📊 [Performance Summary]');
        console.log('─'.repeat(40));
        
        if (this.metrics.firstPaint) {
            console.log(`  First Paint:           ${this.metrics.firstPaint.toFixed(2)}ms`);
        }
        if (this.metrics.firstContentfulPaint) {
            console.log(`  First Contentful Paint: ${this.metrics.firstContentfulPaint.toFixed(2)}ms`);
        }
        if (this.metrics.domContentLoaded) {
            console.log(`  DOM Content Loaded:    ${this.metrics.domContentLoaded.toFixed(2)}ms`);
        }
        if (this.metrics.appInitialized) {
            console.log(`  App Initialized:       ${this.metrics.appInitialized.toFixed(2)}ms`);
        }
        if (this.metrics.timeToInteractive) {
            console.log(`  Time to Interactive:   ${this.metrics.timeToInteractive.toFixed(2)}ms`);
        }
        
        console.log('─'.repeat(40));
    }

    getReport() {
        return {
            ...this.metrics,
            summary: {
                domToApp: this.metrics.timeToInteractive,
                total: this.metrics.appInitialized
            }
        };
    }
}

// 初始化性能监控（尽早执行）
window.performanceMonitor = new PerformanceMonitor();
