const { connect } = require('puppeteer-real-browser');

/**
 * Books an appointment on the therapy portal
 * @param {string} url - The complete appointment booking URL
 * @param {Object} patientInfo - Patient information
 * @param {string} patientInfo.firstName - Patient's first name
 * @param {string} patientInfo.lastName - Patient's last name
 * @param {string} patientInfo.email - Patient's email
 * @param {string} patientInfo.phone - Patient's phone number
 * @param {string} patientInfo.dateOfBirth - Patient's date of birth (MM/DD/YYYY)
 * @returns {Promise<Object>} Result of the booking attempt
 */
async function bookTherapyAppointment(url, patientInfo) {
    // Default values for patient info
    const defaultPatientInfo = {
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        dateOfBirth: '',
        comments: '' // Add comments to default values
    };

    // Merge provided info with defaults
    const patient = { ...defaultPatientInfo, ...patientInfo };

    // Connect to the browser
    const { page, browser } = await connect({
        headless: true,
        turnstile: true,
    });

    let retryCount = 0;
    const maxRetries = 3;
    const baseTimeout = 90000; // 90 seconds

    while (retryCount < maxRetries) {
        try {
            await page.goto(url, {
                waitUntil: 'networkidle0',
                timeout: baseTimeout * (retryCount + 1) // Increase timeout with each retry
            });
            break; // If successful, break the retry loop
        } catch (error) {
            retryCount++;
            console.log(`Navigation attempt ${retryCount} failed: ${error.message}`);
            
            if (retryCount === maxRetries) {
                await browser.close();
                return {
                    status: 'error',
                    message: 'Failed to load the appointment page after multiple attempts',
                    error: error.message
                };
            }
            
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
        }
    }

    try {
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        await delay(3000);

        // Check if the appointment is already booked
        const alreadyBookedContent = await page.evaluate(() => {
            const banner = document.querySelector('.standard-banner-message span');
            return banner ? banner.innerText : null;
        });

        if (alreadyBookedContent && alreadyBookedContent.includes("Please contact the office")) {
            await browser.close();
            return { status: 'booked', message: alreadyBookedContent };
        }

        // Try to click the guest button
        try {
            await page.evaluate(() => {
                const button = document.querySelector('psy-button#ContinueAsGuestButton');
                if (button) button.click();
            });
            await delay(2000);
        } catch (e) {
            console.log('Guest button not found, proceeding with form...', e.message);
        }

        // Fill form fields
        const formFields = {
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxFirstName': patient.firstName,
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxLastName': patient.lastName,
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxEmailAddress': patient.email,
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxMobilePhone': patient.phone,
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxDOB': patient.dateOfBirth,
            '#ctl00_ctl00_BodyContent_BodyContent_TextBoxComments': patient.comments // Add comments field
        };

        for (const [field, value] of Object.entries(formFields)) {
            try {
                await page.evaluate((selector, text) => {
                    const element = document.querySelector(selector);
                    if (element) {
                        element.value = text;
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, field, value);
                await delay(500);
            } catch (e) {
                console.log(`Could not fill field ${field}: ${e.message}`);
            }
        }

        // Try to submit the form
        let submissionSuccess = false;
        
        try {
            // Method 1: Direct evaluate
            await page.evaluate(() => {
                const button = document.querySelector('#ctl00_ctl00_BodyContent_BodyContent_ButtonSubmitRequest');
                if (button) button.click();
            });
            await delay(3000);

            // Check if submission was successful
            submissionSuccess = await page.evaluate(() => {
                return !!document.querySelector('.confirmation-message');
            });

            // Method 2: Try alternative click method if needed
            if (!submissionSuccess) {
                await page.evaluate(() => {
                    const button = document.querySelector('#ctl00_ctl00_BodyContent_BodyContent_ButtonSubmitRequest');
                    if (button) {
                        const event = new MouseEvent('click', {
                            view: window,
                            bubbles: true,
                            cancelable: true
                        });
                        button.dispatchEvent(event);
                    }
                });
                await delay(5000);
                
                submissionSuccess = await page.evaluate(() => {
                    return !!document.querySelector('.confirmation-message');
                });
            }
        } catch (e) {
            console.log('Submit button interaction failed:', e.message);
        }

        // Check final result
        if (submissionSuccess) {
            const confirmationText = await page.evaluate(() => {
                const confirmation = document.querySelector('.confirmation-message');
                return confirmation ? confirmation.innerText : '';
            });
            
            await browser.close();
            return { 
                status: 'success', 
                message: 'Appointment booked successfully', 
                confirmation: confirmationText 
            };
        } else {
            // Try to capture error message if any
            const errorMsg = await page.evaluate(() => {
                const error = document.querySelector('.error-message') || 
                              document.querySelector('.validation-summary-errors');
                return error ? error.innerText : 'Unknown error';
            });
            
            await browser.close();
            return { 
                status: 'error', 
                message: 'Failed to book appointment', 
                error: errorMsg 
            };
        }

    } catch (error) {
        console.error('Error:', error);
        await browser.close();
        return { 
            status: 'error', 
            message: 'Exception occurred', 
            error: error.message 
        };
    }
}

module.exports = { bookTherapyAppointment };