//! unit:t2-resources, dash-gpu leg (plan #68 C1 §3.1, §5): a context made from a device the
//! caller requested (the browser's path) sizes `max_instances` by tier: T1 by the smaller of the
//! buffer and storage-binding limits (the compute passes bind the instance buffer), T2 by the
//! buffer limit alone (no storage buffer).
use dash_gpu::{AdapterChoice, GpuContext, Tier};

fn lavapipe_device() -> (wgpu::Device, wgpu::Queue, wgpu::AdapterInfo, wgpu::Limits) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN));
    let Some(adapter) = adapters
        .into_iter()
        .find(|a| a.get_info().driver == "llvmpipe")
    else {
        panic!("no lavapipe adapter: {:?}", GpuContext::adapter_list())
    };
    let al = adapter.limits();
    let desc = wgpu::DeviceDescriptor {
        required_limits: wgpu::Limits {
            max_buffer_size: al.max_buffer_size,
            max_storage_buffer_binding_size: al.max_storage_buffer_binding_size,
            ..wgpu::Limits::default()
        },
        ..wgpu::DeviceDescriptor::default()
    };
    let Ok((device, queue)) = pollster::block_on(adapter.request_device(&desc)) else {
        panic!("request_device")
    };
    (device, queue, adapter.get_info(), al)
}

#[test]
fn max_instances_follow_the_tier() {
    let (device, queue, info, al) = lavapipe_device();
    assert_ne!(
        al.max_buffer_size, al.max_storage_buffer_binding_size,
        "the adapter's limits do not tell the tiers apart"
    );
    let t1 = GpuContext::from_device(device.clone(), queue.clone(), Tier::T1, info.clone());
    assert_eq!(
        t1.max_instances,
        al.max_buffer_size.min(al.max_storage_buffer_binding_size) / 16
    );
    assert_eq!(t1.tier, Tier::T1);
    let t2 = GpuContext::from_device(device, queue, Tier::T2, info);
    assert_eq!(t2.max_instances, al.max_buffer_size / 16);
    let headless = GpuContext::headless(AdapterChoice::Lavapipe, Tier::T2);
    assert_eq!(
        headless.map(|c| c.max_instances).ok(),
        Some(al.max_buffer_size / 16)
    );
}
