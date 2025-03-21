const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const { default: PQueue } = require('p-queue');
const { setTimeout } = require('timers/promises');
const CONFIG = require('../config');
const { connectToDatabase } = require('./dbService');
const AppointmentStatus = require('../models/AppointmentStatus');

// Helper function for logging
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = type === 'error' ? '❌ ERROR' : 
               type === 'success' ? '✅ SUCCESS' : 
               type === 'warning' ? '⚠️ WARNING' : 'ℹ️ INFO';
  console.log(`[${timestamp}] ${prefix}: ${message}`);
}

/**
 * Extract clinician ID from URL
 * @param {string} href - The appointment URL
 * @returns {string} - Clinician ID
 */
function extractClinicianId(href) {
  try {
    const url = new URL(href);
    const params = new URLSearchParams(url.search);
    return params.get('clinician') || '';
  } catch (error) {
    log(`Error extracting clinician ID: ${error.message}`, 'error');
    return '';
  }
}

/**
 * Record appointment booking in database
 * @param {Object} formData - User form data
 * @param {string} href - The appointment URL
 * @param {string} status - The booking status
 */
async function recordAppointment(formData, href, status = 'unknown') {
  try {
    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      await connectToDatabase();
    }
    
    // Get BookingsLogs model only for clinician name lookup
    const BookingsLogs = mongoose.model('BookingsLogs');
    
    // Extract clinician ID from href
    const clinicianId = extractClinicianId(href);
    
    // Find clinician name if possible
    let clinicianName = '';
    if (clinicianId) {
      const clinician = await BookingsLogs.findOne({ clinicianId }).exec().catch(() => null);
      if (clinician) {
        clinicianName = clinician.name;
      }
    }
    
    // Create or update appointment record
    const result = await AppointmentStatus.findOneAndUpdate(
      { href },
      {
        $set: {
          firstName: formData.firstName || '',
          middleName: formData.middleName || '',
          lastName: formData.lastName || '',
          preferredName: formData.preferredName || '',
          dateOfBirth: formData.dateOfBirth || '',
          phone: formData.phone || '',
          email: formData.email || '',
          comments: formData.comments || '',
          href,
          clinicianId,
          clinicianName,
          status
        }
      },
      { upsert: true, new: true }
    );
    
    log(`Recorded appointment for ${formData.firstName} ${formData.lastName} with status: ${status}`, 'success');
    return result;
  } catch (error) {
    log(`Error recording appointment: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * Check if an appointment slot is already booked
 * @param {string} href - The appointment URL to check
 * @returns {Promise<boolean>} - True if already booked, false otherwise
 */
async function checkIfSlotBooked(href) {
  let browser;
  try {
    log(`Checking availability for appointment: ${href}`);
    
    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      await connectToDatabase();
    }
    
    // FIRST CHECK: Look for existing record in database
    const existingAppointment = await AppointmentStatus.findOne({ href }).exec();
    if (existingAppointment && existingAppointment.status === 'booked') {
      log(`Appointment already marked as booked in database, skipping website check`, 'info');
      return true;
    }
    
    // If not marked as booked in database, check the website
    log(`Appointment not marked as booked in database, checking website...`, 'info');
    
    // Connect to browser
    browser = await puppeteer.connect({ 
      browserWSEndpoint: CONFIG.connectionURL,
      headless: true,
      ignoreHTTPSErrors: true
    });
    
    // Create new page
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    // Optimize page loading
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    // Navigate to appointment URL
    log(`Navigating to appointment URL...`);
    await page.goto(href, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Check for already booked message
    const isAlreadyBooked = await page.evaluate(() => {
      const bannerSelectors = [
        'div.standard-banner-message',
        '.standard-banner-message',
        '.banner-message',
        '.error-message',
        '.message'
      ];
      
      // Try different selectors to find the message
      for (const selector of bannerSelectors) {
        const element = document.querySelector(selector);
        if (element && (
          element.textContent.includes('Please contact the office') || 
          element.textContent.includes('slot is no longer available') ||
          element.textContent.includes('has already been booked')
        )) {
          return true;
        }
      }
      
      // Check page content for common error messages
      const pageText = document.body.innerText;
      if (pageText.includes('slot is no longer available') || 
          pageText.includes('has already been booked') ||
          pageText.includes('time slot has been taken')) {
        return true;
      }
      
      return false;
    });

    if (isAlreadyBooked) {
      log(`Appointment slot is already booked on the website`, 'warning');
      
      // Update AppointmentStatus with booked status
      try {
        // Create a minimal form data object if slot is already booked
        const minimalFormData = {
          firstName: existingAppointment?.firstName || "Unknown",
          lastName: existingAppointment?.lastName || "Patient",
          email: existingAppointment?.email || "unknown@example.com"
        };
        
        // Update AppointmentStatus with booked status
        await recordAppointment(minimalFormData, href, 'booked');
      } catch (updateError) {
        log(`Failed to update AppointmentStatus: ${updateError.message}`, 'error');
      }
      
      return true;
    }
    
    log(`Appointment slot is available`, 'success');
    return false;
    
  } catch (error) {
    log(`Error checking appointment slot: ${error.message}`, 'error');
    return false; // Return false on error to be safe
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Submit an appointment request form
 * @param {Object} formData - Form data for submission
 * @param {string} href - The appointment URL
 * @returns {Promise<Object>} - Result object with success status
 */
async function submitAppointmentForm(formData, href) {
  let browser;
  try {
    log(`Starting form submission for URL: ${href}`);
    
    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      await connectToDatabase();
    }
    
    // FIRST CHECK: Immediately check if appointment is already booked in our database
    const existingAppointment = await AppointmentStatus.findOne({ href }).exec();
    
    if (existingAppointment && existingAppointment.status === 'booked') {
      log(`SKIPPING AUTOMATION: Appointment with href ${href} is already marked as booked in database`, 'warning');
      return {
        success: false,
        message: 'This appointment slot is already booked in our records',
        alreadyBooked: true
      };
    }
    
    // If the appointment exists but is not marked as booked, update the user data
    if (existingAppointment) {
      log(`Found existing appointment record for href ${href}, updating with new user data`, 'info');
      await recordAppointment(formData, href, existingAppointment.status);
    } else {
      // Create new appointment record with unknown status
      log(`Creating new appointment record for href ${href}`, 'info');
      await recordAppointment(formData, href, 'unknown');
    }
    
    // Now check if the slot is actually booked on the website
    const isSlotBooked = await checkIfSlotBooked(href);
    if (isSlotBooked) {
      log(`Slot verification shows it's already booked on the website`, 'warning');
      return {
        success: false,
        message: 'This appointment slot is already booked on the website',
        alreadyBooked: true
      };
    }
    
    // If we got here, the slot is available and we can proceed with booking
    log(`Proceeding with form submission for URL: ${href}`);
    
    // Connect to browser
    browser = await puppeteer.connect({ 
      browserWSEndpoint: CONFIG.connectionURL,
      headless: true,
      ignoreHTTPSErrors: true
    });
    
    // Create new page
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    // Optimize page loading
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (resourceType === 'image' || resourceType === 'font' || resourceType === 'media') {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    // Navigate to appointment URL
    log(`Navigating to appointment URL...`);
    await page.goto(href, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Handle Continue button
    const buttonSelectors = [
      '#ContinueAsGuestButton',
      'psy-button[id="ContinueAsGuestButton"]',
      'button:contains("Continue Without Signing In")',
      'button[onclick="DisplayGuestRequestForm()"]'
    ];
    
    let buttonFound = false;
    for (const selector of buttonSelectors) {
      try {
        const button = await page.waitForSelector(selector, { timeout: 5000 });
        if (button) {
          log(`Clicking continue button with selector: ${selector}`);
          await button.click();
          buttonFound = true;
          break;
        }
      } catch (err) {
        // Continue to try next selector
      }
    }
    
    if (!buttonFound) {
      // Check for specific error banner indicating the appointment is very soon
      const isExpired = await page.evaluate(() => {
        const errorBanner = document.querySelector('psy-banner[level="error"]');
        return errorBanner && errorBanner.textContent.includes('Because the selected appointment is very soon, please call the office to see if it is available.');
      });
    
      if (isExpired) {
        log(`Appointment expired: ${href}`, 'warning');
        await recordAppointment(formData, href, 'expired');
        return { 
          success: false,
          message: 'Appointment expired',
          status: 'expired'
        };
      }
    
      log(`Continue button not found`, 'error');
      return { 
        success: false,
        message: 'Could not find continue button' 
      };
    }
    
    // Wait for form
    await page.waitForSelector('#TableRequestForm', { 
      visible: true,
      timeout: 10000 
    }).catch(() => {});
    
    // Fill form fields from the provided formData
    log('Filling form fields...');
    
    // Map of form field selectors
    const formFieldMap = {
      firstName: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxFirstName',
      middleName: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxMiddleName',
      lastName: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxLastName',
      preferredName: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxPreferredName',
      dateOfBirth: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxDOB',
      phone: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxMobilePhone',
      email: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxEmailAddress',
      comments: '#ctl00_ctl00_BodyContent_BodyContent_TextBoxComments'
    };
    
    // Fill each field if it exists in the formData
    for (const [field, selector] of Object.entries(formFieldMap)) {
      if (formData[field]) {
        await page.type(selector, formData[field]).catch(() => {
          log(`Could not fill field: ${field}`, 'warning');
        });
      }
    }
    
    // Submit form
    const submitSelectors = [
      '#ctl00_ctl00_BodyContent_BodyContent_ButtonSubmitRequest',
      'input[value="Submit Request"]',
      'input[type="submit"]'
    ];
    
    let submitSuccess = false;
    for (const selector of submitSelectors) {
      try {
        const submitButton = await page.waitForSelector(selector, { timeout: 5000 });
        if (submitButton) {
          log(`Clicking submit button with selector: ${selector}`);
          await submitButton.click();
          submitSuccess = true;
          
          // Wait for any potential network activity or DOM changes
          await page.waitForResponse(response => response.status() === 200, { timeout: 15000 }).catch(() => {});
          break;
        }
      } catch (err) {
        // Continue to try next selector
      }
    }
    
    if (!submitSuccess) {
      log(`Form submission failed - could not click submit button`, 'error');
      return { 
        success: false,
        message: 'Could not submit the form' 
      };
    }
    
    // Check for success message
    const isSuccess = await page.evaluate(() => {
      const successSelectors = [
        'div.standard-banner-message',
        '.standard-banner-message',
        '.banner-message', 
        '.success-message',
        '.confirmation-message'
      ];
      
      for (const selector of successSelectors) {
        const element = document.querySelector(selector);
        if (element && (
          element.textContent.includes('Please contact the office') || 
          element.textContent.includes('has been received') ||
          element.textContent.includes('successfully submitted')
        )) {
          return true;
        }
      }
      
      const pageText = document.body.innerText;
      return pageText.includes('has been received') || 
             pageText.includes('successfully submitted') ||
             pageText.includes('thank you for your request');
    });
    
    if (isSuccess) {
      log(`Form submission successful`, 'success');
      
      // Update AppointmentStatus to booked
      await recordAppointment(formData, href, 'booked');
      
      return { 
        success: true,
        message: 'Appointment request submitted successfully'
      };
    }
    
    log(`Form submission completed but success confirmation not found`, 'warning');
    return { 
      success: false,
      message: 'Could not verify if appointment was booked successfully' 
    };
    
  } catch (error) {
    log(`Error in form submission: ${error.message}`, 'error');
    return { 
      success: false, 
      message: `Error submitting form: ${error.message}` 
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Process all pending appointments with 'unknown' status
 * This can be used by a scheduled job to retry failed submissions
 */
async function processUnknownAppointments() {
  log('Starting to process unknown status appointments...', 'info');
  
  try {
    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      await connectToDatabase();
    }
    
    // Find all appointments with unknown status
    const pendingAppointments = await AppointmentStatus.find({ status: 'unknown' }).exec();
    
    log(`Found ${pendingAppointments.length} pending appointments with unknown status`, 'info');
    
    let successCount = 0;
    let failCount = 0;
    
    // Create a queue with concurrency control
    const queue = new PQueue({ concurrency: 5 }); // Adjust concurrency as needed
    
    // Process each appointment
    const results = await Promise.allSettled(pendingAppointments.map(async (appointment) => {
      return queue.add(async () => {
        log(`Processing appointment for ${appointment.firstName} ${appointment.lastName}`, 'info');
        
        // Create formData object from appointment
        const formData = {
          firstName: appointment.firstName,
          lastName: appointment.lastName,
          middleName: appointment.middleName,
          preferredName: appointment.preferredName,
          dateOfBirth: appointment.dateOfBirth,
          phone: appointment.phone,
          email: appointment.email,
          comments: appointment.comments
        };
        
        // Submit the form with retry mechanism
        let retries = 3;
        while (retries > 0) {
          try {
            const result = await submitAppointmentForm(formData, appointment.href);
            
            if (result.success) {
              log(`Successfully processed appointment ${appointment.href}`, 'success');
              successCount++;
              return { success: true, appointment };
            } else {
              log(`Failed to process appointment ${appointment.href}: ${result.message}`, 'warning');
              retries--;
              if (retries > 0) {
                log(`Retrying appointment ${appointment.href} (${retries} retries left)...`, 'info');
                await setTimeout(5000); // Wait before retrying
              } else {
                failCount++;
                return { success: false, appointment, error: result.message };
              }
            }
          } catch (error) {
            log(`Error processing appointment ${appointment.href}: ${error.message}`, 'error');
            retries--;
            if (retries > 0) {
              log(`Retrying appointment ${appointment.href} (${retries} retries left)...`, 'info');
              await setTimeout(5000); // Wait before retrying
            } else {
              failCount++;
              return { success: false, appointment, error: error.message };
            }
          }
        }
      });
    }));
    
    log(`Finished processing unknown appointments. Success: ${successCount}, Failed: ${failCount}`, 'info');
    return {
      total: pendingAppointments.length,
      success: successCount,
      failed: failCount,
      details: results.map(result => result.status === 'fulfilled' ? result.value : result.reason)
    };
    
  } catch (error) {
    log(`Error processing unknown appointments: ${error.message}`, 'error');
    return {
      error: error.message,
      success: 0,
      failed: 0
    };
  }
}

module.exports = {
  checkIfSlotBooked,
  submitAppointmentForm,
  recordAppointment,
  extractClinicianId,
  processUnknownAppointments
};